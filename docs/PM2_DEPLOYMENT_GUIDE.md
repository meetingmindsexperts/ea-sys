# PM2 Deployment Guide for EC2

Complete guide for deploying EA-SYS with PM2 on EC2.

## 📦 Installation

### 1. Install PM2 Globally on EC2

```bash
# SSH into your EC2 instance
ssh -i your-key.pem ec2-user@your-instance-ip

# Install PM2 globally
sudo npm install -g pm2

# Verify installation
pm2 --version
```

### 2. Prepare Your Application

```bash
# Navigate to your project directory
cd /path/to/ea-sys

# Install dependencies
npm install

# Build the Next.js application
npm run build

# Test that the build works
npm start
# Press Ctrl+C to stop after confirming it works
```

## 🚀 Start Application with PM2

### Option 1: Using Ecosystem File (Recommended)

```bash
# Start the application using the ecosystem config
pm2 start ecosystem.config.js

# Or start with specific environment
pm2 start ecosystem.config.js --env production
```

### Option 2: Direct Command

```bash
# Start with basic settings
pm2 start npm --name "ea-sys" -- start

# Or with cluster mode
pm2 start npm --name "ea-sys" -i max -- start
```

## 🔧 PM2 Commands

### Basic Operations

```bash
# List all processes
pm2 list
pm2 status

# Stop application
pm2 stop ea-sys

# Restart application
pm2 restart ea-sys

# Reload application (zero-downtime)
pm2 reload ea-sys

# Delete from PM2
pm2 delete ea-sys

# Show detailed info
pm2 show ea-sys

# Monitor in real-time
pm2 monit
```

### Logs Management

```bash
# View all logs
pm2 logs

# View logs for specific app
pm2 logs ea-sys

# View only error logs
pm2 logs ea-sys --err

# View only output logs
pm2 logs ea-sys --out

# Clear all logs
pm2 flush

# View logs with timestamps
pm2 logs --timestamp "YYYY-MM-DD HH:mm:ss"
```

### Process Management

```bash
# Restart all processes
pm2 restart all

# Stop all processes
pm2 stop all

# Delete all processes
pm2 delete all

# Scale to 4 instances
pm2 scale ea-sys 4

# Reset restart counter
pm2 reset ea-sys
```

## 🔄 Auto-Start on Server Reboot

**Critical for production!** Make PM2 restart your app after server reboot:

```bash
# Generate startup script
pm2 startup

# This will output a command like:
# sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ec2-user --hp /home/ec2-user
# Copy and run that command

# Save current process list
pm2 save

# Test by rebooting
sudo reboot

# After reboot, check if PM2 auto-started
pm2 list
```

## 📊 Monitoring

### Real-Time Monitoring

```bash
# Terminal-based monitoring
pm2 monit

# List with detailed info
pm2 list

# Get metrics
pm2 describe ea-sys
```

### Web-Based Monitoring (Optional - PM2 Plus)

```bash
# Link to PM2 Plus (optional, has free tier)
pm2 link <secret_key> <public_key>

# Or use the free PM2 web interface
pm2 web
# Access at http://your-server-ip:9615
```

## 🔐 Security Best Practices

### 1. Run as Non-Root User

```bash
# Create a dedicated user for the app
sudo useradd -m -s /bin/bash ea-sys-user

# Change ownership
sudo chown -R ea-sys-user:ea-sys-user /path/to/ea-sys

# Switch to that user
sudo su - ea-sys-user

# Start PM2 as that user
pm2 start ecosystem.config.js
pm2 save
```

### 2. Use Environment Files

```bash
# Create .env file with production values
# NEVER commit .env to git

# PM2 will automatically load .env file
# Or specify in ecosystem.config.js:
env_file: '.env.production'
```

### 3. Set Up Nginx Reverse Proxy

```bash
# Install Nginx
sudo yum install -y nginx  # Amazon Linux
# or
sudo apt-get install -y nginx  # Ubuntu

# Configure Nginx
sudo nano /etc/nginx/conf.d/ea-sys.conf
```

**Nginx Configuration:**
```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Serve static files directly (optional optimization)
    location /_next/static {
        alias /path/to/ea-sys/.next/static;
        expires 365d;
        access_log off;
    }

    location /uploads {
        alias /path/to/ea-sys/public/uploads;
        expires 30d;
        access_log off;
    }
}
```

```bash
# Test Nginx config
sudo nginx -t

# Start Nginx
sudo systemctl start nginx
sudo systemctl enable nginx

# Restart Nginx
sudo systemctl restart nginx
```

## 🚀 Deployment Workflow

### Initial Deployment

```bash
# 1. SSH into EC2
ssh -i your-key.pem ec2-user@your-instance-ip

# 2. Clone/Update code
git pull origin main

# 3. Install dependencies
npm install

# 4. Build
npm run build

# 5. Start with PM2
pm2 start ecosystem.config.js

# 6. Save PM2 process list
pm2 save
```

### Update/Redeploy

```bash
# 1. Pull latest code
git pull origin main

# 2. Install new dependencies (if any)
npm install

# 3. Build
npm run build

# 4. Reload with zero-downtime
pm2 reload ea-sys

# Or restart if reload has issues
pm2 restart ea-sys
```

### Automated Deployment Script

Create `deploy.sh`:

```bash
#!/bin/bash

echo "🚀 Starting deployment..."

# Pull latest code
echo "📥 Pulling latest code..."
git pull origin main

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Build application
echo "🔨 Building application..."
npm run build

# Reload PM2
echo "♻️  Reloading PM2..."
pm2 reload ea-sys --update-env

# Save PM2 configuration
pm2 save

echo "✅ Deployment complete!"

# Show status
pm2 status
pm2 logs ea-sys --lines 50
```

Make it executable:
```bash
chmod +x deploy.sh

# Run deployment
./deploy.sh
```

## 📊 Performance Tuning

### Cluster Mode Settings

```javascript
// ecosystem.config.js
{
  instances: "max", // Use all CPU cores
  exec_mode: "cluster",

  // Or specify exact number
  instances: 4,
}
```

### Memory Management

```javascript
{
  max_memory_restart: "1G", // Restart if exceeds 1GB

  // Monitor memory usage
  // pm2 describe ea-sys
}
```

### Log Rotation

```bash
# Install PM2 log rotate module
pm2 install pm2-logrotate

# Configure log rotation
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
```

## 🐛 Troubleshooting

### App Won't Start

```bash
# Check logs
pm2 logs ea-sys --lines 100

# Check error logs
pm2 logs ea-sys --err --lines 50

# Describe process
pm2 describe ea-sys

# Check if port is in use
sudo lsof -i :3000

# Check if build exists
ls -la .next/
```

### High Memory Usage

```bash
# Monitor memory
pm2 monit

# Check which instance is using memory
pm2 list

# Restart specific instance
pm2 restart ea-sys --update-env

# Reduce instances
pm2 scale ea-sys 2
```

### Process Keeps Restarting

```bash
# Check restart count
pm2 list

# View error logs
pm2 logs ea-sys --err

# Check system resources
top
df -h

# Check Node.js version
node --version
```

### Auto-Startup Not Working

```bash
# Remove old startup
pm2 unstartup

# Generate new startup
pm2 startup

# Run the generated command
# (copy from PM2 output)

# Save process list
pm2 save

# Test
sudo reboot
```

## 📈 Monitoring & Alerts

### Check Application Health

```bash
# Quick status check
pm2 status

# Detailed metrics
pm2 describe ea-sys

# CPU and memory usage
pm2 monit
```

### Set Up Basic Monitoring Script

Create `health-check.sh`:

```bash
#!/bin/bash

# Check if PM2 process is running
if ! pm2 list | grep -q "ea-sys.*online"; then
  echo "⚠️  EA-SYS is down! Attempting restart..."
  pm2 restart ea-sys

  # Send alert (optional)
  # curl -X POST https://hooks.slack.com/... \
  #   -d '{"text":"EA-SYS restarted automatically"}'
fi

# Check memory usage
MEM=$(pm2 jlist | jq '.[0].monit.memory')
if [ $MEM -gt 1073741824 ]; then  # 1GB in bytes
  echo "⚠️  High memory usage: $((MEM/1048576))MB"
fi
```

Add to crontab:
```bash
crontab -e

# Add line to check every 5 minutes
*/5 * * * * /path/to/health-check.sh >> /path/to/health-check.log 2>&1
```

## 🔍 Useful Tips

1. **Always test locally first**: `npm run build && npm start`
2. **Use `pm2 reload` for zero-downtime**: Doesn't drop connections
3. **Monitor logs during deployment**: `pm2 logs ea-sys -f`
4. **Save PM2 list after changes**: `pm2 save`
5. **Use ecosystem file**: Easier to manage and version control
6. **Set up alerts**: Use PM2 Plus or custom scripts
7. **Regular log cleanup**: Use pm2-logrotate module
8. **Test auto-startup**: Reboot server and check if app starts

## 📚 Additional Resources

- PM2 Documentation: https://pm2.keymetrics.io/docs/usage/quick-start/
- PM2 Plus (Monitoring): https://pm2.io/
- Next.js Deployment: https://nextjs.org/docs/deployment

## 🆘 Quick Reference

```bash
# Start
pm2 start ecosystem.config.js

# Reload (zero-downtime)
pm2 reload ea-sys

# Restart
pm2 restart ea-sys

# Stop
pm2 stop ea-sys

# Logs
pm2 logs ea-sys

# Monitor
pm2 monit

# Status
pm2 status

# Save
pm2 save

# Startup
pm2 startup && pm2 save
```
