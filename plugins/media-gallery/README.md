# media-gallery

A Claude Code mod that shows pictures and videos right in the chat. Claude calls its `show` tool, or you run `/gallery`, and the transcript gets a strip of thumbnails. A gallery pane opens beside the chat, and you move around it with the keyboard.

## Install

At the prompt of a terminal session:

```
/plugin install media-gallery --marketplace erictran308/claude-code-mods
```

Answer `y` to add the marketplace, then choose a scope. Choose `user` to have it in every project.

It needs [ffmpeg](https://ffmpeg.org) for thumbnails and video: `brew install ffmpeg`. Fullscreen needs [Pepper](https://github.com/erictran308/pepper) and mpv (`brew install mpv`).

## Use it

Ask Claude to show you something ("show me the screenshots in ./shots"), or run it yourself:

```
/gallery ~/Pictures/trip
/gallery shots/*.png demo.mp4
/gallery
```

`/gallery` with no arguments reopens the last gallery, or shows the working folder.

| Key | Grid | One item | Fullscreen |
|---|---|---|---|
| `h` `l` | left, right | previous, next | previous, next |
| `j` `k` | down, up | | back 10 s, forward 10 s |
| `Enter` | view the selected item | back to the grid | |
| `o` / `g` | `o`: view the selected item | `g`: back to the grid | |
| `p` | | play or pause a video | pause |
| `f` | fullscreen | fullscreen | leave fullscreen |
| `q` or `Esc` | close the gallery | close | close |

The keys work while the gallery pane has the keyboard. It takes it when you open it with `/gallery` or a click. When Claude shows something, the pane opens without it, so what you are typing stays in the prompt: press `ctrl+x tab` (or click the pane) to give it the keys. Set **Gallery takes the keys** to `always` in `/config` to have it take them then too. The thumbnail names in the chat are buttons: click one to open it.

## How it shows things

- **Pictures** are PNGs made by ffmpeg (sips for HEIC), cached in your temp folder and drawn with the terminal's picture protocol: Ghostty, kitty, Pepper, iTerm2 3.5 or later.
- **Video in the pane** plays muted at 12 frames a second: ffmpeg rewrites one PNG in real time and the pane swaps it in.
- **Fullscreen** hands the whole set to Pepper's `pepper-play`, which draws video with the graphics chip over the whole tab, with sound, and shows pictures the same way. The gallery's keys keep working. It needs Claude Code running straight in a Pepper tab: tmux and herdr keep Pepper's video box out, so there `f` says why it can't.

In [herdr](https://herdr.dev), Claude Code draws no pictures until you set its override for herdr panes. Add this to `~/.zshrc`, then start Claude Code in a new pane:

```sh
[[ -n $HERDR_ENV ]] && export CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1
```

Claude does not see the pictures it shows: the tool tells it what was shown, by name.

## License

MIT
