#!/bin/bash
# Build Delt demo video — 2 min, polished product showcase
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
FONT="/System/Library/Fonts/Helvetica.ttc"
FONT_BOLD="/System/Library/Fonts/Supplemental/Arial Bold.ttf"

# Use available fonts
if [ ! -f "$FONT_BOLD" ]; then
  FONT_BOLD="$FONT"
fi

# ============================================================
# Video Storyboard (120s total):
#
# 0-8s    Title card (text on solid bg)
# 8-18s   Setup is easy (install gate → ready)
# 18-30s  Welcome screen (tools grid)
# 30-42s  Type a question (user typing)
# 42-54s  AI thinking + streaming
# 54-70s  Full response
# 70-82s  Voice input (mic consent)
# 82-94s  Multitask panel
# 94-106s History sidebar
# 106-114s Privacy badge
# 114-120s End card
# ============================================================

# 1. Title card — white bg with text
ffmpeg -y -f lavfi -i "color=c=#F7F7F8:s=1280x800:d=8" \
  -vf "\
    drawtext=text='delt':fontfile=$FONT_BOLD:fontsize=72:fontcolor=#18182B:x=(w-tw)/2:y=(h/2)-80:enable='between(t,0.5,8)',\
    drawtext=text='Your AI employee.':fontfile=$FONT:fontsize=28:fontcolor=#5C5C72:x=(w-tw)/2:y=(h/2)+10:enable='between(t,1,8)',\
    drawtext=text='100%% local. 100%% private. Set up in 60 seconds.':fontfile=$FONT:fontsize=18:fontcolor=#9494A8:x=(w-tw)/2:y=(h/2)+55:enable='between(t,1.5,8)'" \
  -c:v libx264 -pix_fmt yuv420p -r 30 "$DIR/seg01-title.mp4"
echo "seg01 done"

# 2. Install gate → ready (10s)
ffmpeg -y \
  -loop 1 -t 5 -i "$DIR/16-install-missing.png" \
  -loop 1 -t 5 -i "$DIR/15-install-ready.png" \
  -filter_complex "\
    [0:v]scale=1280:800,zoompan=z='min(zoom+0.0005,1.04)':d=150:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1280x800,\
      drawtext=text='One-click setup':fontfile=$FONT_BOLD:fontsize=24:fontcolor=#FFFFFF:borderw=3:bordercolor=#18182B@0.6:x=(w-tw)/2:y=h-60:enable='between(t,0.5,5)'[v0];\
    [1:v]scale=1280:800,zoompan=z='min(zoom+0.0005,1.04)':d=150:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1280x800,\
      drawtext=text='Ready in seconds':fontfile=$FONT_BOLD:fontsize=24:fontcolor=#FFFFFF:borderw=3:bordercolor=#18182B@0.6:x=(w-tw)/2:y=h-60:enable='between(t,0.5,5)'[v1];\
    [v0][v1]xfade=transition=fade:duration=0.8:offset=4.2" \
  -c:v libx264 -pix_fmt yuv420p -r 30 -t 10 "$DIR/seg02-install.mp4"
echo "seg02 done"

# 3. Welcome screen (12s)
ffmpeg -y -loop 1 -t 12 -i "$DIR/01-welcome.png" \
  -vf "scale=1280:800,\
    zoompan=z='min(zoom+0.0003,1.03)':d=360:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1280x800,\
    drawtext=text='8 business tools, ready to go':fontfile=$FONT_BOLD:fontsize=22:fontcolor=#FFFFFF:borderw=3:bordercolor=#18182B@0.6:x=(w-tw)/2:y=h-55:enable='between(t,0.5,12)'" \
  -c:v libx264 -pix_fmt yuv420p -r 30 "$DIR/seg03-welcome.mp4"
echo "seg03 done"

# 4. Typing a message (12s)
ffmpeg -y -loop 1 -t 12 -i "$DIR/04-typing.png" \
  -vf "scale=1280:800,\
    zoompan=z='min(zoom+0.0005,1.05)':d=360:x='iw/2-(iw/zoom/2)':y='ih*0.7-(ih/zoom/2)':s=1280x800,\
    drawtext=text='Just type what you need':fontfile=$FONT_BOLD:fontsize=22:fontcolor=#FFFFFF:borderw=3:bordercolor=#18182B@0.6:x=(w-tw)/2:y=h-55:enable='between(t,0.5,12)'" \
  -c:v libx264 -pix_fmt yuv420p -r 30 "$DIR/seg04-typing.mp4"
echo "seg04 done"

# 5. Thinking + streaming (12s with xfade)
ffmpeg -y \
  -loop 1 -t 6 -i "$DIR/06-streaming.png" \
  -loop 1 -t 6 -i "$DIR/08-complete.png" \
  -filter_complex "\
    [0:v]scale=1280:800,zoompan=z='min(zoom+0.0004,1.03)':d=180:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1280x800,\
      drawtext=text='AI thinks and writes in real time':fontfile=$FONT_BOLD:fontsize=22:fontcolor=#FFFFFF:borderw=3:bordercolor=#18182B@0.6:x=(w-tw)/2:y=h-55:enable='between(t,0.5,6)'[v0];\
    [1:v]scale=1280:800,zoompan=z='min(zoom+0.0004,1.03)':d=180:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1280x800,\
      drawtext=text='Full email, ready to send':fontfile=$FONT_BOLD:fontsize=22:fontcolor=#FFFFFF:borderw=3:bordercolor=#18182B@0.6:x=(w-tw)/2:y=h-55:enable='between(t,0.5,6)'[v1];\
    [v0][v1]xfade=transition=fade:duration=0.8:offset=5.2" \
  -c:v libx264 -pix_fmt yuv420p -r 30 -t 12 "$DIR/seg05-response.mp4"
echo "seg05 done"

# 6. Scrolled full response (16s)
ffmpeg -y -loop 1 -t 16 -i "$DIR/17-response-scrolled.png" \
  -vf "scale=1280:800,\
    zoompan=z='min(zoom+0.0003,1.03)':d=480:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1280x800,\
    drawtext=text='Emails, proposals, social posts, research...':fontfile=$FONT_BOLD:fontsize=22:fontcolor=#FFFFFF:borderw=3:bordercolor=#18182B@0.6:x=(w-tw)/2:y=h-55:enable='between(t,0.5,16)'" \
  -c:v libx264 -pix_fmt yuv420p -r 30 "$DIR/seg06-full-response.mp4"
echo "seg06 done"

# 7. Mic consent / voice input (12s)
ffmpeg -y -loop 1 -t 12 -i "$DIR/10-mic-consent.png" \
  -vf "scale=1280:800,\
    zoompan=z='min(zoom+0.0004,1.04)':d=360:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1280x800,\
    drawtext=text='Voice input — private, never recorded':fontfile=$FONT_BOLD:fontsize=22:fontcolor=#FFFFFF:borderw=3:bordercolor=#18182B@0.6:x=(w-tw)/2:y=h-55:enable='between(t,0.5,12)'" \
  -c:v libx264 -pix_fmt yuv420p -r 30 "$DIR/seg07-voice.mp4"
echo "seg07 done"

# 8. Multitask panel (12s)
ffmpeg -y -loop 1 -t 12 -i "$DIR/11-multitask-empty.png" \
  -vf "scale=1280:800,\
    zoompan=z='min(zoom+0.0004,1.04)':d=360:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1280x800,\
    drawtext=text='Run tasks in parallel while you chat':fontfile=$FONT_BOLD:fontsize=22:fontcolor=#FFFFFF:borderw=3:bordercolor=#18182B@0.6:x=(w-tw)/2:y=h-55:enable='between(t,0.5,12)'" \
  -c:v libx264 -pix_fmt yuv420p -r 30 "$DIR/seg08-multitask.mp4"
echo "seg08 done"

# 9. History sidebar (12s)
ffmpeg -y -loop 1 -t 12 -i "$DIR/03-sidebar.png" \
  -vf "scale=1280:800,\
    zoompan=z='min(zoom+0.0004,1.04)':d=360:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1280x800,\
    drawtext=text='All your conversations, saved locally':fontfile=$FONT_BOLD:fontsize=22:fontcolor=#FFFFFF:borderw=3:bordercolor=#18182B@0.6:x=(w-tw)/2:y=h-55:enable='between(t,0.5,12)'" \
  -c:v libx264 -pix_fmt yuv420p -r 30 "$DIR/seg09-history.mp4"
echo "seg09 done"

# 10. End card (6s)
ffmpeg -y -f lavfi -i "color=c=#18182B:s=1280x800:d=6" \
  -vf "\
    drawtext=text='delt':fontfile=$FONT_BOLD:fontsize=64:fontcolor=#FFFFFF:x=(w-tw)/2:y=(h/2)-100:enable='between(t,0.3,6)',\
    drawtext=text='Your AI. Your machine. Your data.':fontfile=$FONT:fontsize=24:fontcolor=#9494A8:x=(w-tw)/2:y=(h/2)-20:enable='between(t,0.6,6)',\
    drawtext=text='github.com/neonotics/delt':fontfile=$FONT:fontsize=18:fontcolor=#6C5CE7:x=(w-tw)/2:y=(h/2)+40:enable='between(t,1,6)'" \
  -c:v libx264 -pix_fmt yuv420p -r 30 "$DIR/seg10-end.mp4"
echo "seg10 done"

echo "=== All segments built ==="
