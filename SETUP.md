
# Welcome to Delt

**Your own private AI assistant that runs entirely on your computer.**

Nothing leaves your machine. No cloud. No tracking. Just you and your AI.

---

## What You Need Before Starting

- A Mac computer (macOS 13 or newer)
- An internet connection (just for the initial setup)
- About 5 minutes

That's it.

---

## Setup Instructions

### Step 1 — Open Terminal

Press **Command + Space** on your keyboard. A search bar will appear.

Type the word **Terminal** and press **Enter**.

A window with a dark or light background will open. This is where you'll type a few things. Don't worry — you only need to do this once.

---

### Step 2 — Go to the Delt folder

When you unzipped the file you downloaded, it created a folder. You need to tell Terminal where that folder is.

Type this and press **Enter**:

    cd ~/Downloads/Delt-Installer

If you moved the folder somewhere else (like your Desktop), type that instead:

    cd ~/Desktop/Delt-Installer

---

### Step 3 — Run the installer

Type this and press **Enter**:

    bash install.sh

The installer will now do everything for you automatically:

- It checks if your computer has what it needs
- It installs any missing pieces
- It sets everything up in a folder called **Delt** in your home directory
- It asks if you want to launch right away

If it asks for your password at any point, that's normal. Type your Mac password (you won't see it as you type — that's also normal) and press **Enter**.

---

### Step 4 — Sign in to Claude

When Delt opens in your browser, you may see a screen that says **"Install Claude Code"** or **"Sign in to Claude."**

Follow what it says on screen. It will walk you through it step by step.

You'll need a Claude account. If you don't have one, go to **claude.ai** and create a free account first.

---

### Step 5 — Name your assistant

Once Claude is connected, Delt will ask you two questions:

1. **What's your name?**
2. **What should your bot be called?**

Type your answers and click **Get started**.

That's it. You're in.

---

## How to Open Delt After Setup

Go to your home folder and find the **Delt** folder.

Inside it, double-click the file called **Delt.command**.

Your browser will open with your AI assistant ready to go.

---

## How to Stop Delt

Go to the Terminal window that opened when you launched Delt.

Press **Control + C** on your keyboard.

The assistant will shut down. Your conversations are saved for next time.

---

## Troubleshooting

**"Command not found" when running the installer**
Make sure you're in the right folder. Try typing `ls` and pressing Enter. You should see `install.sh` in the list. If not, go back to Step 2.

**"Node.js not found"**
The installer tries to install this for you. If it can't, go to **nodejs.org**, download the installer for Mac, and run it. Then try Step 3 again.

**"Port 3939 is already in use"**
Delt is probably already running. Check your browser — go to **localhost:3939**. If you need to restart, press Control + C in Terminal first, then double-click Delt.command again.

**The browser opened but the page is blank**
Wait a few seconds and refresh the page. If it's still blank, go back to Terminal and check if there's an error message.

**"Sign in to Claude" keeps showing**
Open Terminal, type `claude`, and press Enter. Follow the instructions to log in. Once you're logged in, go back to Delt in your browser and click "Check again."

---

## Your Privacy

Everything runs on your computer. Your conversations, your files, your data — none of it is sent anywhere except directly to Claude's AI (which is how it answers you). No one else can see what you do in Delt. There is no tracking, no analytics, and no ads.

When you delete Delt, everything goes with it.

