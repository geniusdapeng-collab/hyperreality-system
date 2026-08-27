# Operation Guide

> Load when performing complex desktop operations: `read_file <skill-directory>/docs/operation-guide.md`

---

## Session Start Verification

At the start of every new session, perform end-to-end environment verification:

1. Run preflight check: `bash <skill-directory>/scripts/preflight_check.sh`
2. Take a screenshot to confirm desktop state: `screenshot`
3. Confirm key components are running (Xvfb, window manager, browser)
4. Fix any issues before proceeding

## Web Navigation Strategy

Select navigation method by priority (high → low):

| Priority | Strategy | When to use |
|----------|----------|-------------|
| 1 | `browser_goto` | URL is known |
| 2 | `browser_links` → `browser_goto` | Extract links from list page, then navigate |
| 3 | `browser_click` with selector | Clear CSS/text selector available |
| 4 | `accessibility_tree` + keyboard | Playwright unavailable but browser is running |
| 5 | Launch browser with URL | L1/L2 both unavailable |
| 6 | `get_page_links` → URL launch | L1/L2 unavailable, need to discover links |
| 7 | Address bar input | `Ctrl+L` → `type` URL → `Return` |
| 8 | Screenshot → coordinate click | **Last resort** — visual positioning needed |

**Key rules:**

- **No blind actions** — Never use Tab+Enter navigation without knowing focus position
- **Don't switch strategy on timeout** — If `left_click` times out, increase wait and retry with screenshot; do not fall back to Tab+Enter
- **Prefer non-visual URL discovery** — Use `browser_links` or `get_page_links` to extract links, then navigate by URL

## Layered Verification Strategy

After each action, verify the result using the **lowest token-cost method possible**:

| Level | Method | Tokens | Use case |
|-------|--------|--------|----------|
| L0 | `browser_url` | 0 | Confirm URL after navigation |
| L0.5 | `browser_get_text` / `browser_snapshot` | 0 | Confirm page content rendered |
| L1 | `get_browser_url` (legacy) | ~0 | Playwright unavailable fallback |
| L1.5 | `accessibility_tree` | 0 | Non-browser GUI state verification |
| L2 | `window_list` | ~0 | Confirm window title changed |
| L3 | `screen_text` (regional OCR) | ~50-200 | Confirm text in specific area |
| L4 | `screenshot_region` | ~200-500 | Confirm visual state of specific area |
| L5 | `screenshot` (full screen) | ~1000-2000 | Need full layout info or coordinate location |

**Principles:**

- **Browser**: Prefer L0 (Playwright). If structured data can verify, never screenshot.
- **Non-browser GUI**: Use L1.5 (AXTree) or L2 (window_list).
- **Element location**: Use `browser_click` with selector (zero token). Escalate to L5 only when selectors fail.
- **First step exploration**: Browser → `browser_connect` + `browser_snapshot`; Non-browser → full `screenshot`.

## Verification Template (CoT)

After every key action, follow this pattern:

```
1. Assess current state (using lowest-cost verification)
2. Execute action
3. Verify result (prefer L0-L2, escalate only if needed)
4. State explicitly: "Step X result: observed [STATE]. Expected [X], actual [Y]. Conclusion: [success/fail/retry]."
5. Proceed only after confirmed success
6. On failure, try alternative approach and re-verify
```

**Never** execute multiple actions without verification between them.

## Step Limits

- **Max 30 action calls** per task
- **Max 3 retries** for the same operation
- When approaching the limit, summarize progress and report to user
- If unable to complete within 30 steps, stop and output partial results + remaining steps

## General Operation Rules

1. **Verify before acting** — Assess current state before any operation
2. **Verify after acting** — Confirm result matches expectation after every action
3. **Prefer keyboard shortcuts** — Use `Ctrl+L` for address bar, `Ctrl+S` for save, etc.
4. **Wait for apps** — Use `wait_for_window` / `wait_for_text` (smart wait) over fixed `wait`
5. **Error recovery** — Try alternatives on failure (keyboard instead of click)
6. **Window management** — Use `window_list` → `window_focus` for multi-window scenarios
7. **Regional screenshot** — Use `screenshot_region` to reduce token cost when only a portion matters
8. **Clipboard verification** — Use `clipboard_get` to verify copy/paste results
9. **OCR for precision** — Use `screen_text` when vision model struggles with text recognition

## Recording Timing Protocol

**Core principle: Content first, then record.** Recording does not backtrack.

### Correct sequence

```
1. Navigate to target page / open target app
2. Confirm content fully loaded (use layered verification)
3. Prepare to "about to play / about to operate" state
4. start_recording
5. Execute target operation
6. Wait for operation to complete
7. stop_recording
```

### Pre-recording checklist

Before calling `start_recording`, confirm:

- Target page/app is fully loaded (not loading/blank)
- Media is buffered and ready (player initialized)
- Target UI elements are visible and interactive
- Screen shows the desired "starting frame"

**Mnemonic: See the right screen → Start recording → Do the thing → Stop recording**

### Examples

**Video playback:**
```bash
browser_goto "https://example.com/video"    # Navigate
browser_wait ".video-player"                # Wait for player
browser_get_text ".video-title"             # Verify content
start_recording                             # NOW record
browser_click ".play-button"                # Play
wait 30                                     # Wait
stop_recording                              # Done
```

**Desktop app demo:**
```bash
libreoffice --writer &                      # Launch
wait_for_window "LibreOffice Writer"        # Wait
screenshot                                  # Verify ready
start_recording                             # NOW record
# ... perform demo operations ...           # Operate
stop_recording                              # Done
```

## Recording Notes

- Output directory: `/workspace/computer-use-recordings/` (user-visible, downloadable)
- Max duration: 300s (configurable via `MAX_RECORDING_DURATION`)
- Max files: 10 (oldest auto-cleaned)
- Format: MP4 (H.264, yuv420p, 15fps)
- Audio: Requires PulseAudio (`pulseaudio --start`)
- Desktop must be running before recording (`start_desktop.sh`)
