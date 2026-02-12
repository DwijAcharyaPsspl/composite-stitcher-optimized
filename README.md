# Composite Video Stitcher Service

Memory-optimized video stitching service for Spectacles AR recordings.

## Quick Start (Local Development)

```bash
# Install dependencies
npm install

# Set environment variables
export SUPABASE_URL="https://your-project.supabase.co"
export SUPABASE_SERVICE_KEY="your-service-key"

# Run the service
npm start
```

## Docker

```bash
# Build
docker build -t composite-stitcher .

# Run
docker run -p 8080:8080 \
  -e SUPABASE_URL="https://your-project.supabase.co" \
  -e SUPABASE_SERVICE_KEY="your-service-key" \
  composite-stitcher
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/stitch` | POST | Start video stitching job |

## Documentation

- **Azure Deployment:** See `docs/AZURE_DEPLOYMENT_GUIDE.md`

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Yes | Service role key |
| `PORT` | No | Server port (default: 8080) |

## Memory Optimizations

This service is optimized for low-memory environments:

- Scales video to 720p during processing
- Uses FFmpeg `ultrafast` preset
- Limits encoding threads to 2
- Sequential frame downloads (no parallel memory spikes)

## System Requirements

- Node.js 18+
- FFmpeg installed
- 2 GB RAM minimum
- 10 GB temp disk space
