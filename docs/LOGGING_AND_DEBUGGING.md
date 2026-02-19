# Logging and Debugging Guide

## Application Logs

### Local Development

```bash
# View all logs
tail -f logs/app.log

# View only errors
tail -f logs/error.log

# Search for specific errors
grep -i "upload" logs/app.log
grep -i "photo" logs/error.log

# View logs with context (10 lines before/after)
grep -C 10 "error" logs/app.log
```

### EC2 Deployment

```bash
# SSH into your EC2 instance
ssh -i your-key.pem ec2-user@your-instance-ip

# Navigate to your project directory
cd /path/to/ea-sys

# View application logs in real-time
tail -f logs/app.log

# View only errors
tail -f logs/error.log

# Check PM2 logs (if using PM2)
pm2 logs

# Check system logs
sudo journalctl -u your-app-name -f

# Search for photo upload errors
grep -i "photo upload" logs/app.log | tail -50

# Monitor logs continuously with filtering
tail -f logs/app.log | grep -E "(upload|photo|error|warn)"
```

### Vercel Deployment

**Using Vercel Dashboard:**
1. Go to https://vercel.com/
2. Select your project
3. Click "Logs" in the sidebar
4. Filter by:
   - Deployment
   - Time range
   - Log level (Error, Warning, Info)

**Using Vercel CLI:**
```bash
# Install Vercel CLI
npm i -g vercel

# Login
vercel login

# View real-time logs
vercel logs --follow

# View logs for specific deployment
vercel logs https://your-deployment-url.vercel.app

# Filter logs
vercel logs --output=raw | grep "upload"
```

## Photo Upload Debugging

### Current Implementation Limitation

⚠️ **Important**: The current photo upload uses local file system storage which:
- ✅ Works on EC2
- ❌ Does NOT work on Vercel (read-only filesystem)

### Checking Photo Upload Status

#### On EC2:
```bash
# Check if upload directory exists and is writable
ls -la public/uploads/photos/

# Check recent uploads
find public/uploads/photos/ -type f -mtime -1

# Check directory permissions
ls -ld public/uploads/photos/

# Make directory writable if needed
chmod -R 755 public/uploads/photos/

# Check disk space
df -h
```

#### Application Logs to Check:
```bash
# View photo upload attempts
grep "Photo upload attempt" logs/app.log

# View upload errors
grep "Photo upload failed" logs/error.log

# View file write errors
grep "Failed to write file" logs/error.log

# View directory creation errors
grep "Failed to create upload directory" logs/error.log
```

### Common Photo Upload Errors

#### 1. **Permission Denied**
```
Error: EACCES: permission denied, mkdir '/path/to/public/uploads'
```

**Solution (EC2):**
```bash
# Set proper permissions
chmod -R 755 public/uploads
chown -R $USER:$USER public/uploads
```

#### 2. **No Space Left on Device**
```
Error: ENOSPC: no space left on device
```

**Solution:**
```bash
# Check disk space
df -h

# Clean up old uploads if needed
find public/uploads/photos/ -type f -mtime +30 -delete
```

#### 3. **Vercel Deployment Error**
```
Photo uploads are not supported on Vercel
```

**Solution:** Use cloud storage (see below)

## Cloud Storage Solutions (for Vercel)

If deploying to Vercel, you need to use cloud storage:

### Option 1: Cloudinary (Recommended - Free Tier Available)

1. **Sign up:** https://cloudinary.com/
2. **Install SDK:**
   ```bash
   npm install cloudinary
   ```

3. **Add Environment Variables:**
   ```env
   CLOUDINARY_CLOUD_NAME=your_cloud_name
   CLOUDINARY_API_KEY=your_api_key
   CLOUDINARY_API_SECRET=your_api_secret
   ```

4. **Update upload route:**
   ```typescript
   // src/app/api/upload/photo/route.ts
   import { v2 as cloudinary } from 'cloudinary';

   cloudinary.config({
     cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
     api_key: process.env.CLOUDINARY_API_KEY,
     api_secret: process.env.CLOUDINARY_API_SECRET,
   });

   // Upload to Cloudinary
   const result = await cloudinary.uploader.upload(base64String, {
     folder: 'ea-sys/photos',
     resource_type: 'image',
   });

   return NextResponse.json({ url: result.secure_url });
   ```

### Option 2: AWS S3

1. **Install SDK:**
   ```bash
   npm install @aws-sdk/client-s3
   ```

2. **Add Environment Variables:**
   ```env
   AWS_REGION=us-east-1
   AWS_ACCESS_KEY_ID=your_key
   AWS_SECRET_ACCESS_KEY=your_secret
   AWS_S3_BUCKET_NAME=your-bucket
   ```

### Option 3: Vercel Blob Storage

1. **Install:**
   ```bash
   npm install @vercel/blob
   ```

2. **Add to Vercel project settings**

3. **Use in upload route:**
   ```typescript
   import { put } from '@vercel/blob';

   const blob = await put(filename, file, {
     access: 'public',
   });

   return NextResponse.json({ url: blob.url });
   ```

## Real-Time Monitoring

### Browser Console
1. Open Developer Tools (F12)
2. Go to Network tab
3. Filter by "upload"
4. Try uploading a photo
5. Check:
   - Request status code
   - Response body
   - Request payload

### Server Logs
```bash
# EC2: Monitor logs in real-time
tail -f logs/app.log | grep -E "(upload|error|warn)"

# Vercel: Monitor logs
vercel logs --follow

# Local development: Console logs
npm run dev
```

## Debugging Checklist

When photo upload fails:

- [ ] Check browser console for client-side errors
- [ ] Check Network tab for failed requests
- [ ] Check application logs (`logs/app.log` or Vercel logs)
- [ ] Verify file size < 500KB
- [ ] Verify file type is JPEG, PNG, or WebP
- [ ] Check if directory exists and is writable (EC2 only)
- [ ] Check disk space (EC2 only)
- [ ] Verify environment variables are set
- [ ] Check if deployed on Vercel (needs cloud storage)

## Log Levels

The application uses different log levels:

- **DEBUG**: Detailed information for debugging
- **INFO**: General informational messages
- **WARN**: Warning messages (something unexpected but not critical)
- **ERROR**: Error messages (something failed)

Set log level in `.env`:
```env
LOG_LEVEL=debug  # For development
LOG_LEVEL=info   # For production
```

## Getting Help

If you still encounter issues:

1. **Collect logs:**
   ```bash
   # Save last 100 lines of app log
   tail -100 logs/app.log > debug-app.log

   # Save all error logs
   cat logs/error.log > debug-error.log
   ```

2. **Check photo upload request:**
   - Take screenshot of Network tab in browser
   - Copy request/response data

3. **Provide context:**
   - Where is it deployed? (EC2/Vercel/Local)
   - What's the file size and type?
   - What error message appears?
