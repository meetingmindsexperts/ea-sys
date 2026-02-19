# Web-Based Log Viewer Guide

Access your Docker container logs through a beautiful web interface at `events.meetingmindsgroup.com/logs`

## 🎨 Features

### Real-Time Log Viewing
- **Live Updates**: Toggle auto-refresh to get new logs every 5 seconds
- **Smooth Animations**: New log entries slide in with smooth transitions
- **Syntax Highlighting**: JSON logs are automatically formatted and color-coded
- **Retro Terminal Aesthetic**: Dark, glowing interface with CRT-style effects

### Filtering & Search
- **Level Filter**: View All, Errors only, Warnings only, or Info logs
- **Time Range**: Last 10 minutes, 1 hour, 6 hours, 24 hours, or all logs
- **Search**: Filter logs by any text (searches both message and timestamp)
- **Real-time Stats**: See total entries and filtered count

### User Experience
- **Auto-Scroll**: "New Logs" button appears when new entries arrive
- **Download**: Export filtered logs to a timestamped text file
- **Responsive**: Works on desktop, tablet, and mobile
- **Authenticated**: Requires login (Admin/Organizer only)

## 🔐 Access Control

The log viewer is **restricted to SUPER_ADMIN only**:
- ✅ **SUPER_ADMIN** - Full access
- ❌ **ADMIN** - Blocked (403 Forbidden)
- ❌ **ORGANIZER** - Blocked (403 Forbidden)
- ❌ **REVIEWER** - Blocked (403 Forbidden)
- ❌ **SUBMITTER** - Blocked (403 Forbidden)

## 📍 How to Access

### Option 1: Organization Settings
1. Log in as **SUPER_ADMIN**
2. Navigate to **Settings** in the sidebar
3. Scroll to **System Logs** section (below Team Members)
4. Click **"Open Logs"** button

### Option 2: Direct URL
Navigate to: `https://events.meetingmindsgroup.com/logs`

**Note**: You must be logged in as SUPER_ADMIN to access this page.

## 🎯 Usage Examples

### Monitor Photo Upload Issues
1. Set level filter to **"Errors"**
2. Search for: `photo`
3. View detailed error traces with timestamps

### Check Recent Application Errors
1. Set time range to **"Last 1 hour"**
2. Set level filter to **"Errors"**
3. Download logs for offline analysis

### Live Monitoring During Deployment
1. Toggle **"Auto"** refresh ON
2. Watch logs update in real-time as deployment progresses
3. Check for any warnings or errors

### Debug Specific API Endpoint
1. Search for: `/api/events`
2. Review all logs related to event API calls
3. Use time range to focus on recent activity

## 🎨 Interface Guide

### Header Controls
```
┌─────────────────────────────────────────────────────┐
│ 🖥️ SYSTEM LOGS          🟢 ea-sys (container)      │
├─────────────────────────────────────────────────────┤
│ [Search...]  [Level: All ▼]  [Time: 1h ▼]         │
│ [Auto] [Export]                                     │
│                                                     │
│ 150 entries (filtered from 200) 🟢 Live            │
└─────────────────────────────────────────────────────┘
```

### Log Entry Format
```
🔴 Feb 19 14:23:45  [ERROR] Photo upload failed
   {
     "err": { "message": "ENOENT: no such file or directory" },
     "msg": "Photo upload failed",
     "userId": "user_abc123"
   }

⚠️ Feb 19 14:22:10  [WARN] High memory usage detected

ℹ️ Feb 19 14:20:33  [INFO] Registration created successfully
```

### Color Coding
- 🔴 **Red** - Errors (critical issues)
- ⚠️ **Amber** - Warnings (potential issues)
- 🔵 **Cyan** - Info (general logs)
- ⚪ **Gray** - Debug (detailed traces)

## 📊 Log Levels Explained

### Error (Red)
Critical failures that need immediate attention:
- Failed API requests
- Database connection errors
- File system errors
- Uncaught exceptions

### Warn (Amber)
Potential issues that should be investigated:
- Deprecated API usage
- High memory/CPU usage
- Slow database queries
- Failed validation (non-critical)

### Info (Cyan)
Normal application events:
- Successful operations
- User actions
- API request logs
- System status updates

### Debug (Gray)
Detailed diagnostic information:
- Variable values
- Function execution traces
- Performance metrics
- Development logs

## 🚀 Best Practices

### Daily Monitoring
- Check logs once daily for new errors
- Set time range to "Last 24 hours"
- Review warning count trends

### Troubleshooting
1. **Identify the issue**: Filter by error level
2. **Find the timeline**: Use time range selectors
3. **Gather context**: Search for related keywords
4. **Export evidence**: Download logs for further analysis

### Performance Optimization
- Use specific filters to reduce log volume
- Disable auto-refresh when not actively monitoring
- Download logs instead of keeping browser tab open

## 📥 Downloading Logs

Click the **"Export"** button to download:
- **Filename**: `ea-sys-logs-2026-02-19-14-30-00.txt`
- **Format**: Plain text with timestamps
- **Content**: Only filtered/searched logs (not all logs)
- **Size**: Typically 100KB - 5MB depending on log count

Example downloaded format:
```
[2026-02-19T14:23:45.123Z] [ERROR] Photo upload failed
[2026-02-19T14:22:10.456Z] [WARN] High memory usage detected
[2026-02-19T14:20:33.789Z] [INFO] Registration created successfully
```

## 🔄 Auto-Refresh Behavior

When **Auto** is enabled (green button):
- Fetches new logs every **5 seconds**
- Maintains current filter settings
- Does NOT auto-scroll (use "New Logs" button to scroll)
- Shows "Live" indicator in stats bar
- Can be toggled on/off anytime

## 🐛 Troubleshooting

### "Docker not available" Error
**Cause**: Running on Vercel (not EC2)
**Solution**: Web logs only work on EC2 deployment. Use `docker logs ea-sys` via SSH instead.

### No Logs Showing
**Possible causes**:
1. **Filters too restrictive**: Try "All" level and "All" time range
2. **No logs in time range**: Expand time range
3. **Container not running**: Check container status on EC2
4. **Search term too specific**: Clear search field

### Logs Not Updating
**Possible causes**:
1. **Auto-refresh disabled**: Toggle "Auto" button to enable
2. **Container stopped**: Container may have crashed
3. **Network issue**: Check internet connection
4. **Session expired**: Refresh page and log in again

### Slow Loading
**Possible causes**:
1. **Large log volume**: Use shorter time range (1h instead of 24h)
2. **EC2 under load**: Container may be busy processing requests
3. **Network latency**: Wait a few seconds for logs to load

## 🎨 Design Features

### Retro-Futuristic Terminal
- **Dark charcoal background** with subtle grid pattern
- **CRT scanline effect** for authentic terminal feel
- **Glowing cyan accents** matching your brand (#00aade)
- **JetBrains Mono font** for crisp, readable code
- **Smooth animations** for professional feel

### Accessibility
- High contrast text for readability
- Keyboard navigation support
- Screen reader friendly
- Responsive on all devices

## 📚 Related Documentation

- **Docker Logging Guide**: `/docs/DOCKER_LOGGING_GUIDE.md` - SSH-based log access
- **Logging & Debugging**: `/docs/LOGGING_AND_DEBUGGING.md` - Application logging setup

## 🆘 Support

If you encounter issues with the web log viewer:
1. Try SSH access: `ssh ubuntu@your-ec2-ip`
2. View logs directly: `docker logs -f ea-sys`
3. Check Docker status: `docker ps`
4. Review nginx logs: `sudo tail -f /var/log/nginx/error.log`

---

**Pro Tip**: Bookmark `events.meetingmindsgroup.com/logs` for quick access during deployments and troubleshooting sessions!
