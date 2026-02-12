FROM node:18-slim

# Install FFmpeg and curl (for health checks)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Run as non-root user for security
RUN useradd -r -u 1001 -g root appuser && \
    chown -R appuser:root /app
USER appuser

# Start the application
CMD ["node", "index.js"]
