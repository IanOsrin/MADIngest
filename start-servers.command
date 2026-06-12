#!/bin/bash
# start-servers.command
# Double-click to launch GalloIngest (3001) and MAD AI Tools (3002)

# Open GalloIngest in a new Terminal window
osascript <<'EOF'
tell application "Terminal"
  do script "cd /Users/fmserver/Desktop/GalloIngestV1.1 && echo '▶ Starting GalloIngest on port 3001...' && node server.js"
  activate
end tell
EOF

# Small delay so the windows don't stack on top of each other
sleep 0.5

# Open MAD AI Tools in a second Terminal window
osascript <<'EOF'
tell application "Terminal"
  do script "cd /Users/fmserver/Desktop/mad-ai-tools && echo '▶ Starting MAD AI Tools on port 3002...' && node server.js"
  activate
end tell
EOF

echo "Both servers launched."
