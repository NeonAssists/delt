"""Generate title card, end card, and text-bar overlays for Delt demo video."""
from PIL import Image, ImageDraw, ImageFont
import os

DIR = os.path.dirname(os.path.abspath(__file__))
W, H = 1280, 800
BAR_H = 52

# Try to load nice fonts, fall back to default
def load_font(size, bold=False):
    paths = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/SFNSDisplay.ttf",
    ]
    for p in paths:
        try:
            return ImageFont.truetype(p, size)
        except:
            continue
    return ImageFont.load_default()

font_big = load_font(72, bold=True)
font_med = load_font(28)
font_small = load_font(18)
font_bar = load_font(22, bold=True)
font_end_big = load_font(64, bold=True)
font_end_med = load_font(24)
font_end_sm = load_font(18)

# ---- Title card ----
img = Image.new("RGB", (W, H), "#F7F7F8")
d = ImageDraw.Draw(img)
# "delt"
bb = d.textbbox((0, 0), "delt", font=font_big)
d.text(((W - (bb[2]-bb[0]))//2, H//2 - 100), "delt", fill="#18182B", font=font_big)
# subtitle
t = "Your AI employee."
bb = d.textbbox((0, 0), t, font=font_med)
d.text(((W - (bb[2]-bb[0]))//2, H//2 - 5), t, fill="#5C5C72", font=font_med)
# tagline
t = "100% local. 100% private. Set up in 60 seconds."
bb = d.textbbox((0, 0), t, font=font_small)
d.text(((W - (bb[2]-bb[0]))//2, H//2 + 45), t, fill="#9494A8", font=font_small)
img.save(os.path.join(DIR, "card-title.png"))
print("card-title.png")

# ---- End card ----
img = Image.new("RGB", (W, H), "#18182B")
d = ImageDraw.Draw(img)
t = "delt"
bb = d.textbbox((0, 0), t, font=font_end_big)
d.text(((W - (bb[2]-bb[0]))//2, H//2 - 110), t, fill="#FFFFFF", font=font_end_big)
t = "Your AI. Your machine. Your data."
bb = d.textbbox((0, 0), t, font=font_end_med)
d.text(((W - (bb[2]-bb[0]))//2, H//2 - 25), t, fill="#9494A8", font=font_end_med)
t = "github.com/neonotics/delt"
bb = d.textbbox((0, 0), t, font=font_end_sm)
d.text(((W - (bb[2]-bb[0]))//2, H//2 + 30), t, fill="#6C5CE7", font=font_end_sm)
img.save(os.path.join(DIR, "card-end.png"))
print("card-end.png")

# ---- Text bar overlays (bottom bar with semi-transparent bg) ----
labels = [
    ("bar-install", "One-click setup — runs entirely on your machine"),
    ("bar-ready", "Ready in seconds"),
    ("bar-welcome", "8 business tools, ready to go"),
    ("bar-typing", "Just type what you need"),
    ("bar-streaming", "AI thinks and writes in real time"),
    ("bar-complete", "Full email, ready to send"),
    ("bar-response", "Emails, proposals, social posts, research — all local"),
    ("bar-voice", "Voice input — private, never recorded"),
    ("bar-multitask", "Run tasks in parallel while you chat"),
    ("bar-history", "All your conversations, saved locally"),
]

for name, text in labels:
    # Create a full-width bar image (1280 x BAR_H) with semi-transparent dark bg
    bar = Image.new("RGBA", (W, BAR_H), (24, 24, 43, 180))
    d = ImageDraw.Draw(bar)
    bb = d.textbbox((0, 0), text, font=font_bar)
    tx = (W - (bb[2] - bb[0])) // 2
    ty = (BAR_H - (bb[3] - bb[1])) // 2 - 2
    d.text((tx, ty), text, fill="#FFFFFF", font=font_bar)
    bar.save(os.path.join(DIR, f"{name}.png"))
    print(f"{name}.png")

# ---- Composite: screenshot + bar overlay ----
composites = [
    ("16-install-missing.png", "bar-install", "comp-install.png"),
    ("15-install-ready.png", "bar-ready", "comp-ready.png"),
    ("01-welcome.png", "bar-welcome", "comp-welcome.png"),
    ("04-typing.png", "bar-typing", "comp-typing.png"),
    ("06-streaming.png", "bar-streaming", "comp-streaming.png"),
    ("08-complete.png", "bar-complete", "comp-complete.png"),
    ("17-response-scrolled.png", "bar-response", "comp-response.png"),
    ("10-mic-consent.png", "bar-voice", "comp-voice.png"),
    ("11-multitask-empty.png", "bar-multitask", "comp-multitask.png"),
    ("03-sidebar.png", "bar-history", "comp-history.png"),
]

for screenshot, bar_name, out_name in composites:
    # Load screenshot, resize to 1280x800
    ss = Image.open(os.path.join(DIR, screenshot)).convert("RGBA")
    ss = ss.resize((W, H), Image.LANCZOS)
    # Load bar
    bar = Image.open(os.path.join(DIR, f"{bar_name}.png"))
    # Paste bar at bottom
    ss.paste(bar, (0, H - BAR_H), bar)
    ss.convert("RGB").save(os.path.join(DIR, out_name))
    print(out_name)

print("\n=== All cards and composites generated ===")
