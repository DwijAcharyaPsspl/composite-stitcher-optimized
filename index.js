const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs').promises;
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// MEMORY OPTIMIZATION: Limit concurrent operations
const MAX_CONCURRENT_DOWNLOADS = 5;

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    service: 'composite-stitcher-optimized',
    memoryOptimized: true
  });
});

/**
 * Get public URL for a video in Supabase Storage
 */
function getPublicVideoUrl(bucket, filePath) {
  const { data } = supabase.storage.from(bucket).getPublicUrl(filePath);
  return data.publicUrl;
}

/**
 * Download file with retry logic
 */
async function downloadWithRetry(bucket, filePath, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { data, error } = await supabase.storage.from(bucket).download(filePath);
      if (error) throw error;
      return data;
    } catch (error) {
      if (attempt === maxRetries) throw error;
      console.log(`[RETRY] Download attempt ${attempt} failed, retrying...`);
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

/**
 * Download files in batches to limit memory usage
 */
async function downloadInBatches(items, downloadFn, batchSize = MAX_CONCURRENT_DOWNLOADS) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(downloadFn));
    results.push(...batchResults);
    
    // Force garbage collection hint
    if (global.gc) global.gc();
  }
  return results;
}

// Main stitching endpoint
app.post('/stitch', async (req, res) => {
  console.log(`[STITCH] Raw request body:`, JSON.stringify(req.body, null, 2));
  
  const { 
    sessionId, 
    bucket, 
    frameRate, 
    sampleRate,
    videoStorageFolder,
    audioStorageFolder,
    stitchedOutputFolder,
    useVerticalCrop,
    hasAudio
  } = req.body;
  
  const verticalCropEnabled = useVerticalCrop === true || useVerticalCrop === 'true';
  
  console.log(`[STITCH] Starting OPTIMIZED job for session: ${sessionId}`);
  console.log(`[STITCH] Vertical crop (9:16): ${verticalCropEnabled}`);
  console.log(`[STITCH] Has audio: ${hasAudio}`);
  
  // Respond immediately
  res.json({ 
    success: true,
    status: 'processing', 
    sessionId,
    message: 'Optimized stitching job started'
  });
  
  // Process in background
  processStitchJob(
    sessionId, 
    bucket, 
    frameRate, 
    sampleRate,
    videoStorageFolder || 'composite-video',
    audioStorageFolder || 'composite-audio',
    stitchedOutputFolder || 'composite-stitched',
    {
      useVerticalCrop: verticalCropEnabled,
      hasAudio: hasAudio !== false
    }
  ).catch(error => {
    console.error(`[STITCH ERROR] ${sessionId}:`, error);
  });
});

async function processStitchJob(
  sessionId, 
  bucket, 
  requestFrameRate, 
  sampleRate, 
  videoStorageFolder, 
  audioStorageFolder, 
  stitchedOutputFolder,
  options = {}
) {
  // Use unique temp directory to avoid conflicts
  const timestamp = Date.now();
  const randomId = Math.random().toString(36).substring(2, 7);
  const workDir = `/tmp/composite_${timestamp}_${randomId}`;
  const framesDir = `${workDir}/frames`;
  const audioDir = `${workDir}/audio`;
  
  try {
    // Create work directories
    await fs.mkdir(framesDir, { recursive: true });
    await fs.mkdir(audioDir, { recursive: true });
    
    console.log(`[DOWNLOAD] Fetching metadata for ${sessionId}`);
    
    // Get metadata
    const { data: statsData } = await supabase.storage
      .from(bucket)
      .download(`metadata/${sessionId}/final_stats.json`);
    
    if (!statsData) {
      throw new Error('No metadata found');
    }
    
    const statsText = await statsData.text();
    const stats = JSON.parse(statsText);
    
    // DEBUG: Log full metadata for troubleshooting
    console.log(`[METADATA DEBUG] ========================================`);
    console.log(`[METADATA DEBUG] Raw metadata: ${statsText}`);
    console.log(`[METADATA DEBUG] recordingStats.totalFrames: ${stats.recordingStats?.totalFrames}`);
    console.log(`[METADATA DEBUG] recordingStats.totalAudioChunks: ${stats.recordingStats?.totalAudioChunks}`);
    console.log(`[METADATA DEBUG] recordingStats.duration (ms): ${stats.recordingStats?.duration}`);
    console.log(`[METADATA DEBUG] recordingStats.durationSeconds: ${stats.recordingStats?.durationSeconds}`);
    console.log(`[METADATA DEBUG] stitchingInfo.targetFrameRate: ${stats.stitchingInfo?.targetFrameRate}`);
    console.log(`[METADATA DEBUG] stitchingInfo.actualFrameRate: ${stats.stitchingInfo?.actualFrameRate}`);
    console.log(`[METADATA DEBUG] Request frameRate: ${requestFrameRate}`);
    console.log(`[METADATA DEBUG] ========================================`);
    
    console.log(`[INFO] Frames: ${stats.recordingStats.totalFrames}, Audio chunks: ${stats.recordingStats.totalAudioChunks}`);
    
    // CRITICAL: Use the correct frame rate to ensure video duration matches recording duration
    // Priority: 1) Pre-calculated actualFrameRate from metadata
    //           2) Calculate from totalFrames / durationSeconds
    //           3) Request frameRate
    //           4) Default 5 fps
    const totalFrames = stats.recordingStats.totalFrames;
    const durationSeconds = stats.recordingStats.durationSeconds || (stats.recordingStats.duration / 1000);
    const metadataActualFrameRate = stats.stitchingInfo?.actualFrameRate;
    
    let frameRate;
    
    // Priority 1: Use pre-calculated actualFrameRate from metadata (most reliable)
    if (metadataActualFrameRate && metadataActualFrameRate > 0 && metadataActualFrameRate < 60) {
      frameRate = metadataActualFrameRate;
      console.log(`[FRAMERATE] Using metadata actualFrameRate: ${frameRate.toFixed(4)} fps`);
    }
    // Priority 2: Calculate from duration
    else if (durationSeconds && durationSeconds > 0 && totalFrames > 0) {
      frameRate = totalFrames / durationSeconds;
      console.log(`[FRAMERATE] Calculated from metadata: ${totalFrames} frames / ${durationSeconds.toFixed(2)}s = ${frameRate.toFixed(4)} fps`);
    }
    // Priority 3: Use request frame rate
    else if (requestFrameRate && requestFrameRate > 0 && requestFrameRate < 60) {
      frameRate = requestFrameRate;
      console.log(`[FRAMERATE] Using request frame rate: ${frameRate} fps`);
    }
    // Priority 4: Default fallback
    else {
      frameRate = 5;
      console.log(`[FRAMERATE] WARNING: Could not determine frame rate, using default: ${frameRate} fps`);
    }
    
    // Sanity check: frame rate should be reasonable (0.5 to 60 fps)
    if (frameRate < 0.5) {
      console.log(`[FRAMERATE] WARNING: Frame rate too low (${frameRate}), clamping to 0.5 fps`);
      frameRate = 0.5;
    } else if (frameRate > 60) {
      console.log(`[FRAMERATE] WARNING: Frame rate too high (${frameRate}), clamping to 60 fps`);
      frameRate = 60;
    }
    
    console.log(`[FRAMERATE] Final frame rate: ${frameRate.toFixed(4)} fps`);
    console.log(`[FRAMERATE] Expected video duration: ${(totalFrames / frameRate).toFixed(2)} seconds`);
    
    // MEMORY OPTIMIZATION: Download frames in smaller batches
    console.log(`[DOWNLOAD] Downloading ${stats.recordingStats.totalFrames} frames in batches...`);
    let downloadedFrames = 0;
    
    for (let i = 1; i <= stats.recordingStats.totalFrames; i++) {
      try {
        const framePath = `${videoStorageFolder}/${sessionId}/frame_${String(i).padStart(5, '0')}.jpg`;
        const data = await downloadWithRetry(bucket, framePath);
        
        if (data) {
          const buffer = Buffer.from(await data.arrayBuffer());
          if (buffer.length > 0) {
            await fs.writeFile(`${framesDir}/frame_${String(i).padStart(5, '0')}.jpg`, buffer);
            downloadedFrames++;
          }
        }
        
        // Log progress every 25 frames
        if (i % 25 === 0) {
          console.log(`[DOWNLOAD] Frames: ${i}/${stats.recordingStats.totalFrames}`);
        }
      } catch (err) {
        console.error(`[ERROR] Frame ${i}: ${err.message}`);
      }
    }
    
    console.log(`[DOWNLOAD] Downloaded ${downloadedFrames} frames`);
    
    if (downloadedFrames === 0) {
      throw new Error('No valid frames downloaded');
    }
    
    // CRITICAL: Renumber frames sequentially to avoid gaps that break FFmpeg
    // FFmpeg's image2 demuxer stops at the first missing frame number!
    const frameFiles = await fs.readdir(framesDir);
    const sortedFrames = frameFiles.filter(f => f.endsWith('.jpg')).sort();
    
    console.log(`[RENUMBER] Found ${sortedFrames.length} frame files, renumbering sequentially...`);
    
    for (let i = 0; i < sortedFrames.length; i++) {
      const oldPath = `${framesDir}/${sortedFrames[i]}`;
      const newPath = `${framesDir}/seq_${String(i + 1).padStart(5, '0')}.jpg`;
      await fs.rename(oldPath, newPath);
    }
    
    // Update frame count to actual downloaded frames
    const actualFrameCount = sortedFrames.length;
    console.log(`[RENUMBER] Renumbered ${actualFrameCount} frames (seq_00001.jpg to seq_${String(actualFrameCount).padStart(5, '0')}.jpg)`);
    
    // Recalculate frame rate based on actual frames to maintain correct duration
    if (actualFrameCount !== totalFrames) {
      console.log(`[WARNING] Frame count mismatch: expected ${totalFrames}, got ${actualFrameCount}`);
      // Keep the same frame rate so video duration matches recording duration
      // (fewer frames at same rate = proportionally shorter video, which is correct)
    }
    
    // Download audio chunks if needed
    let downloadedAudio = 0;
    const missingAudioChunks = [];
    if (options.hasAudio && stats.recordingStats.totalAudioChunks > 0) {
      console.log(`[DOWNLOAD] Downloading ${stats.recordingStats.totalAudioChunks} audio chunks...`);
      
      // Calculate expected vs actual
      const expectedChunksFor20s = Math.floor(durationSeconds * 10); // 10 chunks per second at 100ms
      console.log(`[AUDIO DEBUG] Expected chunks for ${durationSeconds.toFixed(1)}s: ~${expectedChunksFor20s}, Metadata reports: ${stats.recordingStats.totalAudioChunks}`);
      
      for (let i = 1; i <= stats.recordingStats.totalAudioChunks; i++) {
        try {
          const audioPath = `${audioStorageFolder}/${sessionId}/audio_chunk_${i}.wav`;
          const data = await downloadWithRetry(bucket, audioPath);
          
          if (data) {
            const buffer = Buffer.from(await data.arrayBuffer());
            if (buffer.length > 0) {
              await fs.writeFile(`${audioDir}/audio_chunk_${i}.wav`, buffer);
              downloadedAudio++;
            } else {
              console.log(`[WARNING] Audio chunk ${i} is empty`);
              missingAudioChunks.push(i);
            }
          } else {
            console.log(`[WARNING] Audio chunk ${i} not found in storage`);
            missingAudioChunks.push(i);
          }
        } catch (err) {
          console.error(`[ERROR] Audio chunk ${i}: ${err.message}`);
          missingAudioChunks.push(i);
        }
      }
      
      console.log(`[DOWNLOAD] Downloaded ${downloadedAudio}/${stats.recordingStats.totalAudioChunks} audio chunks`);
      if (missingAudioChunks.length > 0) {
        console.log(`[WARNING] Missing audio chunks: ${missingAudioChunks.slice(0, 20).join(', ')}${missingAudioChunks.length > 20 ? '...' : ''}`);
        console.log(`[WARNING] Total missing: ${missingAudioChunks.length} chunks - this will cause audio gaps!`);
      }
    }
    
    console.log(`[STITCH] Creating video from frames...`);
    
    // Verify renumbered frames exist
    const seqFrameFiles = await fs.readdir(framesDir);
    const seqFiles = seqFrameFiles.filter(f => f.startsWith('seq_'));
    console.log(`[DEBUG] Renumbered frames in directory: ${seqFiles.length}`);
    console.log(`[DEBUG] First few frames: ${seqFiles.slice(0, 5).join(', ')}`);
    
    const videoOutputPath = `${workDir}/video_only.mp4`;
    const audioOutputPath = `${workDir}/audio.wav`;
    const finalOutputPath = `${workDir}/final.mp4`;
    
    // MEMORY OPTIMIZATION: Build optimized video filters
    // Scale down to 720p max to reduce memory usage significantly
    const videoFilters = [];
    
    if (options.useVerticalCrop) {
      // First crop to 9:16, then scale down
      videoFilters.push('crop=ih*9/16:ih:(iw-ih*9/16)/2:0');
      videoFilters.push('scale=720:1280');  // 720x1280 for vertical
    } else {
      // Scale to 720p maintaining aspect ratio
      videoFilters.push('scale=1280:720:force_original_aspect_ratio=decrease');
    }
    
    // Ensure even dimensions
    videoFilters.push('pad=ceil(iw/2)*2:ceil(ih/2)*2');
    
    console.log(`[FFMPEG] Video filters: ${videoFilters.join(', ')}`);
    
    // Step 1: Create video from frames with MEMORY OPTIMIZED settings
    await new Promise((resolve, reject) => {
      const command = ffmpeg()
        .input(`${framesDir}/seq_%05d.jpg`)  // Use renumbered sequence files
        .inputOptions([
          '-framerate', String(frameRate),
          '-start_number', '1'
        ])
        .videoCodec('libx264')
        .videoFilters(videoFilters)
        .outputOptions([
          '-r', String(frameRate),    // CRITICAL: Set output frame rate to match input
          '-pix_fmt', 'yuv420p',
          '-preset', 'ultrafast',     // MEMORY: Much faster, less memory
          '-crf', '28',               // MEMORY: Slightly lower quality, faster encoding
          '-tune', 'fastdecode',      // MEMORY: Optimize for fast decoding
          '-threads', '2',            // MEMORY: Limit threads to reduce memory
          '-movflags', '+faststart'   // Enable streaming
        ])
        .output(videoOutputPath)
        .on('start', cmd => console.log('[FFMPEG] Video command:', cmd))
        .on('stderr', (stderrLine) => {
          // Only log important lines
          if (stderrLine.includes('frame=') || stderrLine.includes('error') || stderrLine.includes('Error')) {
            console.log('[FFMPEG STDERR]', stderrLine);
          }
        })
        .on('end', () => {
          console.log('[FFMPEG] Video created successfully');
          resolve();
        })
        .on('error', (err, stdout, stderr) => {
          console.error('[FFMPEG ERROR]', err.message);
          reject(err);
        });
      
      command.run();
    });
    
    // Step 2: Combine audio chunks if available
    if (downloadedAudio > 0) {
      console.log(`[STITCH] Combining ${downloadedAudio} audio chunks...`);
      
      const audioListPath = `${audioDir}/audio_list.txt`;
      const audioLines = [];
      
      for (let i = 1; i <= stats.recordingStats.totalAudioChunks; i++) {
        const chunkPath = `${audioDir}/audio_chunk_${i}.wav`;
        try {
          await fs.access(chunkPath);
          audioLines.push(`file '${chunkPath}'`);
        } catch {
          // File doesn't exist, skip
        }
      }
      
      if (audioLines.length > 0) {
        await fs.writeFile(audioListPath, audioLines.join('\n'));
        
        await new Promise((resolve, reject) => {
          ffmpeg()
            .input(audioListPath)
            .inputOptions(['-f', 'concat', '-safe', '0'])
            .audioCodec('pcm_s16le')
            .audioFrequency(sampleRate || 44100)
            .audioChannels(1)
            .output(audioOutputPath)
            .on('start', cmd => console.log('[FFMPEG] Audio command:', cmd))
            .on('end', () => {
              console.log('[FFMPEG] Audio concatenated');
              resolve();
            })
            .on('error', (err) => {
              console.error('[FFMPEG AUDIO ERROR]', err.message);
              reject(err);
            })
            .run();
        });
      } else {
        downloadedAudio = 0;
      }
    }
    
    // Step 3: Merge video and audio
    let finalVideoPath;
    
    if (downloadedAudio > 0) {
      console.log(`[STITCH] Merging video and audio...`);
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(videoOutputPath)
          .input(audioOutputPath)
          .videoCodec('copy')
          .audioCodec('aac')
          .audioFrequency(sampleRate || 44100)
          .audioBitrate('96k')  // Lower bitrate to save size
          .audioChannels(1)
          .outputOptions(['-shortest', '-movflags', '+faststart'])
          .output(finalOutputPath)
          .on('start', cmd => console.log('[FFMPEG] Merge command:', cmd))
          .on('end', () => {
            console.log('[FFMPEG] Merge complete');
            resolve();
          })
          .on('error', (err) => {
            console.error('[FFMPEG MERGE ERROR]', err.message);
            reject(err);
          })
          .run();
      });
      finalVideoPath = finalOutputPath;
    } else {
      finalVideoPath = videoOutputPath;
    }
    
    // Step 4: Upload final video
    const outputFilePath = `${stitchedOutputFolder}/${sessionId}/final.mp4`;
    console.log(`[UPLOAD] Uploading to ${outputFilePath}...`);
    
    const finalVideoBuffer = await fs.readFile(finalVideoPath);
    console.log(`[UPLOAD] Final video size: ${(finalVideoBuffer.length / 1024 / 1024).toFixed(2)} MB`);
    
    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(outputFilePath, finalVideoBuffer, {
        contentType: 'video/mp4',
        upsert: true
      });
    
    if (uploadError) {
      throw uploadError;
    }
    
    const publicUrl = getPublicVideoUrl(bucket, outputFilePath);
    console.log(`[SUCCESS] Video uploaded: ${publicUrl}`);
    
    // Update completion metadata
    const completionMetadata = {
      sessionId,
      status: 'completed',
      completedAt: new Date().toISOString(),
      outputPath: outputFilePath,
      publicUrl: publicUrl,
      videoFormat: {
        verticalCrop: options.useVerticalCrop || false,
        optimized: true,
        resolution: options.useVerticalCrop ? '720x1280' : '1280x720'
      }
    };
    
    await supabase.storage
      .from(bucket)
      .upload(`metadata/${sessionId}/completion.json`, 
        JSON.stringify(completionMetadata, null, 2), {
        contentType: 'application/json',
        upsert: true
      });
    
    // Cleanup
    await fs.rm(workDir, { recursive: true, force: true });
    console.log(`[DONE] Session ${sessionId} completed successfully!`);
    
  } catch (error) {
    console.error(`[ERROR] Stitching failed for ${sessionId}:`, error);
    
    // Upload error status
    const errorMetadata = {
      sessionId,
      status: 'failed',
      error: error.message,
      failedAt: new Date().toISOString()
    };
    
    try {
      await supabase.storage
        .from(bucket)
        .upload(`metadata/${sessionId}/error.json`, 
          JSON.stringify(errorMetadata, null, 2), {
          contentType: 'application/json',
          upsert: true
        });
    } catch (metaError) {
      console.error('[META ERROR]', metaError);
    }
    
    // Cleanup on error
    try {
      await fs.rm(workDir, { recursive: true, force: true });
    } catch (cleanupError) {
      // Ignore cleanup errors
    }
    
    throw error;
  }
}

app.listen(PORT, () => {
  console.log(`🎬 Optimized Composite Stitcher running on port ${PORT}`);
  console.log(`✅ Health check: http://localhost:${PORT}/health`);
  console.log(`🧠 Memory optimizations: ENABLED`);
});
