# Composite Video Stitcher - Azure Deployment Guide

## Service Overview

**Service Name:** Composite Video Stitcher  
**Purpose:** Stitches video frames and audio chunks from Spectacles AR glasses into MP4 videos  
**Technology Stack:** Node.js 18+, Express.js, FFmpeg  

### What This Service Does
1. Receives a webhook request with session metadata
2. Downloads JPEG frames and WAV audio chunks from Supabase Storage
3. Uses FFmpeg to stitch frames into video and merge with audio
4. Uploads the final MP4 back to Supabase Storage
5. Returns completion status

---

## Infrastructure Requirements

### Compute Requirements

| Resource | Minimum | Recommended | Notes |
|----------|---------|-------------|-------|
| CPU | 2 vCPU | 4 vCPU | FFmpeg is CPU-intensive |
| RAM | 1 GB | 2 GB | For processing 720p video |
| Disk | 10 GB temp | 20 GB temp | Frames stored temporarily |

### Azure Service Options (Choose One)

#### Option A: Azure App Service (Recommended for simplicity)
- **Plan:** B2 or higher (Basic tier)
- **OS:** Linux
- **Pros:** Easy deployment, auto-scaling, managed infrastructure
- **Cons:** Limited control over FFmpeg installation

#### Option B: Azure Container Instances (Recommended for this workload)
- **CPU:** 2 cores
- **Memory:** 2 GB
- **Pros:** Pay per execution, FFmpeg included in container
- **Cons:** Cold start latency

#### Option C: Azure Kubernetes Service (For scale)
- **Node Pool:** Standard_B2s or higher
- **Pros:** Full control, horizontal scaling
- **Cons:** More complex to manage

#### Option D: Azure Functions (NOT Recommended)
- Timeout limits (max 10 min) may not be sufficient for long videos
- Memory constraints

---

## Docker Configuration

### Dockerfile

```dockerfile
FROM node:18-slim

# Install FFmpeg
RUN apt-get update && apt-get install -y \
    ffmpeg \
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

# Run as non-root user
RUN useradd -r -u 1001 appuser
USER appuser

# Start the application
CMD ["node", "index.js"]
```

### Docker Build & Push Commands

```bash
# Build the image
docker build -t composite-stitcher:latest .

# Tag for Azure Container Registry
docker tag composite-stitcher:latest <your-acr>.azurecr.io/composite-stitcher:latest

# Push to ACR
az acr login --name <your-acr>
docker push <your-acr>.azurecr.io/composite-stitcher:latest
```

---

## Environment Variables

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `SUPABASE_URL` | Yes | Supabase project URL | `https://xyz.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Yes | Supabase service role key (NOT anon key) | `eyJhbGc...` |
| `PORT` | No | Server port (default: 8080) | `8080` |
| `NODE_ENV` | No | Environment | `production` |

### Azure Key Vault (Recommended)

Store sensitive values in Azure Key Vault:
```bash
# Create secrets
az keyvault secret set --vault-name <vault-name> --name "SUPABASE-URL" --value "<url>"
az keyvault secret set --vault-name <vault-name> --name "SUPABASE-SERVICE-KEY" --value "<key>"
```

---

## API Specification

### Health Check Endpoint

```
GET /health
```

**Response:**
```json
{
  "status": "healthy",
  "service": "composite-stitcher-optimized",
  "memoryOptimized": true
}
```

### Stitch Video Endpoint

```
POST /stitch
Content-Type: application/json
```

**Request Body:**
```json
{
  "sessionId": "composite_1234567890_abc123",
  "bucket": "specs-bucket",
  "frameRate": 15.5,
  "sampleRate": 44100,
  "videoStorageFolder": "composite-video",
  "audioStorageFolder": "composite-audio",
  "stitchedOutputFolder": "composite-stitched",
  "useVerticalCrop": false,
  "hasAudio": true
}
```

**Response (Immediate):**
```json
{
  "success": true,
  "status": "processing",
  "sessionId": "composite_1234567890_abc123",
  "message": "Optimized stitching job started"
}
```

**Note:** Processing happens asynchronously. Check Supabase Storage for:
- `metadata/{sessionId}/completion.json` - Success
- `metadata/{sessionId}/error.json` - Failure

---

## Networking Requirements

### Inbound
- Port 8080 (HTTP) from the internet or VNet
- Health probe endpoint: `/health`

### Outbound
- HTTPS to Supabase (*.supabase.co, *.snapcloud.dev)
- No other external dependencies

### Firewall Rules (if applicable)
```
Allow outbound TCP 443 to:
- *.supabase.co
- *.snapcloud.dev
```

---

## Azure Deployment - Step by Step

### Option A: Azure Container Instances (Quickest)

```bash
# 1. Create resource group
az group create --name rg-composite-stitcher --location eastus

# 2. Create container instance
az container create \
  --resource-group rg-composite-stitcher \
  --name composite-stitcher \
  --image <your-acr>.azurecr.io/composite-stitcher:latest \
  --cpu 2 \
  --memory 2 \
  --ports 8080 \
  --environment-variables \
    SUPABASE_URL=<your-url> \
    NODE_ENV=production \
  --secure-environment-variables \
    SUPABASE_SERVICE_KEY=<your-key> \
  --dns-name-label composite-stitcher \
  --restart-policy OnFailure

# 3. Get the public URL
az container show \
  --resource-group rg-composite-stitcher \
  --name composite-stitcher \
  --query ipAddress.fqdn \
  --output tsv
```

### Option B: Azure App Service

```bash
# 1. Create App Service Plan
az appservice plan create \
  --name asp-composite-stitcher \
  --resource-group rg-composite-stitcher \
  --is-linux \
  --sku B2

# 2. Create Web App
az webapp create \
  --resource-group rg-composite-stitcher \
  --plan asp-composite-stitcher \
  --name composite-stitcher \
  --deployment-container-image-name <your-acr>.azurecr.io/composite-stitcher:latest

# 3. Configure environment variables
az webapp config appsettings set \
  --resource-group rg-composite-stitcher \
  --name composite-stitcher \
  --settings \
    SUPABASE_URL=<your-url> \
    SUPABASE_SERVICE_KEY=<your-key> \
    WEBSITES_PORT=8080
```

---

## Monitoring & Logging

### Application Insights (Recommended)

Add to application for Azure-native monitoring:

```javascript
// Add to index.js (optional)
const appInsights = require('applicationinsights');
appInsights.setup(process.env.APPINSIGHTS_CONNECTIONSTRING)
  .setAutoCollectRequests(true)
  .setAutoCollectPerformance(true)
  .setAutoCollectExceptions(true)
  .start();
```

### Log Analytics

Configure diagnostic settings to send container logs to Log Analytics workspace.

### Alerts to Configure

| Alert | Condition | Severity |
|-------|-----------|----------|
| High CPU | CPU > 80% for 5 min | Warning |
| High Memory | Memory > 80% for 5 min | Warning |
| Container Restart | Restart count > 3 in 1 hour | Critical |
| Health Check Fail | /health returns non-200 | Critical |

---

## Scaling Considerations

### Auto-scaling Rules (if using App Service or AKS)

```json
{
  "rules": [
    {
      "metricTrigger": {
        "metricName": "CpuPercentage",
        "operator": "GreaterThan",
        "threshold": 70,
        "timeAggregation": "Average"
      },
      "scaleAction": {
        "direction": "Increase",
        "type": "ChangeCount",
        "value": "1",
        "cooldown": "PT5M"
      }
    }
  ]
}
```

### Processing Limits

| Video Length | Frames (~15fps) | Processing Time | Memory Peak |
|--------------|-----------------|-----------------|-------------|
| 10 seconds | ~150 frames | ~30 seconds | ~500 MB |
| 30 seconds | ~450 frames | ~90 seconds | ~800 MB |
| 60 seconds | ~900 frames | ~3 minutes | ~1.2 GB |

---

## Security Checklist

- [ ] Store SUPABASE_SERVICE_KEY in Azure Key Vault
- [ ] Enable HTTPS only (disable HTTP)
- [ ] Configure network security groups if in VNet
- [ ] Enable Azure Defender for container registries
- [ ] Set up managed identity for Key Vault access
- [ ] Review and restrict CORS if needed
- [ ] Enable audit logging

---

## Rollback Plan

1. Keep previous container image tagged (e.g., `:previous`)
2. To rollback:
   ```bash
   az container create ... --image <acr>/composite-stitcher:previous
   ```

---

## Cost Estimation (USD/month)

| Service | Configuration | Estimated Cost |
|---------|---------------|----------------|
| Container Instances | 2 vCPU, 2 GB, ~100 hours/month | ~$15-25 |
| App Service B2 | Always on | ~$55 |
| Container Registry | Basic | ~$5 |
| **Total (ACI)** | | **~$20-30/month** |
| **Total (App Service)** | | **~$60/month** |

---

## Support Contacts

| Role | Contact | Responsibility |
|------|---------|----------------|
| Application Owner | [Your Name] | Business logic, API changes |
| DevOps | [DevOps Engineer] | Infrastructure, deployment |
| Supabase Admin | [Admin] | Storage, authentication |

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2024-XX-XX | Initial optimized release |
