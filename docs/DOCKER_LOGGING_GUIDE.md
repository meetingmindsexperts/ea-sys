# Docker Logging Guide for EA-SYS

Complete guide for accessing and managing application logs in Docker deployment.

## 📋 Log Configuration

The `docker-compose.prod.yml` is configured with:
- **Driver**: `json-file` (Docker's default, human-readable JSON format)
- **Max Size**: `10m` (10 megabytes per log file)
- **Max Files**: `5` (keeps last 5 rotated log files = 50MB total)
- **Auto-rotation**: Logs automatically rotate when they reach 10MB

This prevents disk space issues while maintaining recent log history.

## 🔍 Viewing Logs

### Real-Time Logs (Follow Mode)

```bash
# View live logs from ea-sys container
docker compose -f docker-compose.prod.yml logs -f ea-sys

# View logs from all services
docker compose -f docker-compose.prod.yml logs -f

# Alternative: using docker logs directly
docker logs -f ea-sys
```

### Recent Logs

```bash
# Last 100 lines
docker compose -f docker-compose.prod.yml logs --tail=100 ea-sys

# Last 50 lines (default in GitHub Actions)
docker compose -f docker-compose.prod.yml logs --tail=50 ea-sys

# Last 20 lines
docker logs --tail=20 ea-sys
```

### Logs with Timestamps

```bash
# Show timestamps for each log entry
docker compose -f docker-compose.prod.yml logs -f --timestamps ea-sys

# Alternative format
docker logs -f --timestamps ea-sys
```

### Logs from Specific Time Range

```bash
# Logs since specific time
docker logs --since "2026-02-19T10:00:00" ea-sys

# Logs from last 1 hour
docker logs --since 1h ea-sys

# Logs from last 30 minutes
docker logs --since 30m ea-sys

# Logs until specific time
docker logs --until "2026-02-19T12:00:00" ea-sys

# Combine since and until
docker logs --since "2026-02-19T10:00:00" --until "2026-02-19T12:00:00" ea-sys
```

## 🔎 Searching Logs

### Using grep

```bash
# Search for errors
docker logs ea-sys 2>&1 | grep -i error

# Search for specific API endpoint
docker logs ea-sys 2>&1 | grep "/api/upload/photo"

# Search for photo upload attempts
docker logs ea-sys 2>&1 | grep "photo"

# Search with context (3 lines before and after match)
docker logs ea-sys 2>&1 | grep -C 3 "error"

# Case-insensitive search
docker logs ea-sys 2>&1 | grep -i "unauthorized"
```

### Filter by Log Level

```bash
# Only show error logs (if using structured logging)
docker logs ea-sys 2>&1 | grep '"level":"error"'

# Show warnings and errors
docker logs ea-sys 2>&1 | grep -E '"level":"(error|warn)"'

# Show info level logs
docker logs ea-sys 2>&1 | grep '"level":"info"'
```

## 📁 Log File Locations

Docker stores logs in JSON format on the host:

```bash
# Find exact log file location
docker inspect --format='{{.LogPath}}' ea-sys

# Common location on Linux:
/var/lib/docker/containers/<container-id>/<container-id>-json.log

# View raw log file (requires root)
sudo cat /var/lib/docker/containers/<container-id>/<container-id>-json.log

# Follow raw log file
sudo tail -f /var/lib/docker/containers/<container-id>/<container-id>-json.log
```

## 🔄 Log Rotation

Logs automatically rotate based on configuration:
- When a log file reaches 10MB, Docker creates a new file
- Up to 5 files are kept (current + 4 rotated)
- Oldest files are deleted when limit is reached
- Total maximum: 50MB of logs

### Manual Log Cleanup

```bash
# Clear all logs for ea-sys container (requires restart)
sudo sh -c "truncate -s 0 /var/lib/docker/containers/\$(docker inspect --format='{{.Id}}' ea-sys)/\$(docker inspect --format='{{.Id}}' ea-sys)-json.log"

# Easier method: restart container (keeps rotated logs)
docker compose -f docker-compose.prod.yml restart ea-sys

# Complete log cleanup: remove and recreate container
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml up -d
```

## 📊 Log Monitoring Commands

### Container Status

```bash
# Check if container is running
docker compose -f docker-compose.prod.yml ps

# Detailed container info
docker inspect ea-sys

# Resource usage (CPU, memory)
docker stats ea-sys --no-stream

# Live resource monitoring
docker stats ea-sys
```

### Health Checks

```bash
# Test if app is responding
curl -I http://localhost:3000

# Check application health (if health endpoint exists)
curl http://localhost:3000/api/health

# View nginx access logs (if using nginx reverse proxy)
sudo tail -f /var/log/nginx/access.log

# View nginx error logs
sudo tail -f /var/log/nginx/error.log
```

## 🐛 Debugging Common Issues

### Container Won't Start

```bash
# Check logs for startup errors
docker logs ea-sys

# Check if port is already in use
sudo lsof -i :3000

# View docker daemon logs
sudo journalctl -u docker -f

# Check container exit code
docker inspect ea-sys --format='{{.State.ExitCode}}'
```

### Application Errors

```bash
# Follow logs and look for errors
docker logs -f ea-sys 2>&1 | grep -i error

# Check recent error logs
docker logs --since 10m ea-sys 2>&1 | grep -i error

# View full error context
docker logs --tail=200 ea-sys 2>&1 | grep -B 5 -A 5 "error"
```

### Photo Upload Issues

```bash
# Monitor photo upload attempts
docker logs -f ea-sys 2>&1 | grep "photo upload"

# Check for upload failures
docker logs ea-sys 2>&1 | grep "Photo upload failed"

# View file system inside container
docker exec ea-sys ls -la /app/public/uploads/photos/

# Check directory permissions
docker exec ea-sys ls -la /app/public/uploads/
```

### Database Connection Issues

```bash
# Check for database errors
docker logs ea-sys 2>&1 | grep -i "database\|prisma"

# Test database connectivity from inside container
docker exec ea-sys npx prisma db execute --stdin <<< "SELECT 1;"

# View environment variables (sanitized)
docker exec ea-sys env | grep DATABASE
```

## 📝 Application Logs (Pino Logger)

Your application uses Pino logger which outputs structured JSON logs. These are captured by Docker.

### Log Structure

```json
{
  "level": 30,
  "time": 1708347600000,
  "pid": 1,
  "hostname": "ea-sys",
  "msg": "Photo upload attempt",
  "userId": "user_123",
  "isVercel": false
}
```

### Log Levels

- `10` - trace (very detailed)
- `20` - debug
- `30` - info (default)
- `40` - warn
- `50` - error
- `60` - fatal

### Filtering by Log Level

```bash
# Only errors and fatal
docker logs ea-sys 2>&1 | jq 'select(.level >= 50)'

# Only warnings and above
docker logs ea-sys 2>&1 | jq 'select(.level >= 40)'

# Info level only
docker logs ea-sys 2>&1 | jq 'select(.level == 30)'

# Pretty print JSON logs
docker logs ea-sys 2>&1 | jq '.'
```

**Note**: Requires `jq` installed: `sudo apt-get install -y jq`

## 🚀 Deployment Logs

GitHub Actions automatically shows recent logs after deployment:

```bash
echo "==> Recent logs"
docker compose -f docker-compose.prod.yml logs --tail=50 ea-sys
```

You can view these in the GitHub Actions workflow run output.

## 📊 Advanced Monitoring

### Continuous Monitoring Script

Create `monitor-logs.sh`:

```bash
#!/bin/bash
# Monitor logs for errors in real-time

echo "🔍 Monitoring ea-sys logs for errors..."
echo "Press Ctrl+C to stop"
echo ""

docker logs -f ea-sys 2>&1 | while read line; do
  # Highlight errors in red
  if echo "$line" | grep -qi "error"; then
    echo -e "\033[0;31m[ERROR]\033[0m $line"
  # Highlight warnings in yellow
  elif echo "$line" | grep -qi "warn"; then
    echo -e "\033[0;33m[WARN]\033[0m $line"
  # Normal logs
  else
    echo "$line"
  fi
done
```

Make it executable:
```bash
chmod +x monitor-logs.sh
./monitor-logs.sh
```

### Export Logs to File

```bash
# Export all logs to file
docker logs ea-sys > ~/ea-sys-logs.txt 2>&1

# Export with timestamps
docker logs --timestamps ea-sys > ~/ea-sys-logs-$(date +%Y%m%d-%H%M%S).txt 2>&1

# Export only errors
docker logs ea-sys 2>&1 | grep -i error > ~/ea-sys-errors.txt

# Export logs from last hour
docker logs --since 1h ea-sys > ~/ea-sys-recent.txt 2>&1
```

## 🔔 Log Alerts (Optional)

Set up basic alerting with a cron job:

```bash
# Edit crontab
crontab -e

# Add line to check for errors every 5 minutes
*/5 * * * * docker logs --since 5m ea-sys 2>&1 | grep -i "error" && echo "Errors detected in ea-sys logs" | mail -s "EA-SYS Alert" admin@example.com
```

## 🆘 Quick Reference

```bash
# View live logs
docker logs -f ea-sys

# Last 100 lines
docker logs --tail=100 ea-sys

# Last 1 hour
docker logs --since 1h ea-sys

# Search for errors
docker logs ea-sys 2>&1 | grep -i error

# Search for photo uploads
docker logs ea-sys 2>&1 | grep "photo"

# Container status
docker ps

# Restart container
docker compose -f docker-compose.prod.yml restart ea-sys

# View resource usage
docker stats ea-sys --no-stream

# Clear logs (restart container)
docker compose -f docker-compose.prod.yml restart ea-sys
```

## 📚 Additional Resources

- Docker Logging Documentation: https://docs.docker.com/config/containers/logging/
- Docker Compose Logging: https://docs.docker.com/compose/compose-file/compose-file-v3/#logging
- Pino Logger Documentation: https://getpino.io/
