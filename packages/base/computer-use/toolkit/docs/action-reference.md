# Action Reference

Complete action table for `computer_tool.py`. All actions are invoked via:

```bash
python3 <skill-directory>/scripts/computer_tool.py '<action_json>'
```

---

## Basic Operations

| Action | Parameters | Description |
|--------|-----------|-------------|
| `cursor_position` | — | Get current mouse coordinates |
| `double_click` | [x], [y], [key] | Double left-click |
| `hover` | x, y, [duration] | Hover to trigger tooltip (default 2s) |
| `key` | keys | Key press / combo (e.g. ctrl+s, Return, alt+Tab) |
| `left_click` | [x], [y], [key] | Left-click (optional modifier key) |
| `left_click_drag` | start_x, start_y, end_x, end_y | Drag operation |
| `middle_click` | [x], [y], [key] | Middle-click |
| `mouse_hold` | x, y, [duration], [button] | Hold mouse button (default left, 1s) |
| `mouse_move` | x, y | Move mouse to position |
| `right_click` | [x], [y], [key] | Right-click |
| `screenshot` | — | Capture full screen, return base64 PNG |
| `screenshot_region` | x, y, width, height | Capture region, reduces token cost |
| `scroll` | direction, [amount], [x], [y] | Scroll (up/down/left/right) |
| `triple_click` | [x], [y], [key] | Triple left-click (select line) |
| `type` | text | Type text |
| `wait` | [duration] | Wait specified seconds (max 30s) |
| `zoom` | direction, [amount], [x], [y], [method] | Zoom (in/out/reset, default Ctrl+scroll) |

## Window Management

| Action | Parameters | Description |
|--------|-----------|-------------|
| `window_close` | [window_id], [name] | Close window by ID or title |
| `window_focus` | [window_id], [name] | Focus window by ID or title |
| `window_list` | — | List all visible windows |
| `window_minimize` | window_id | Minimize window |
| `window_move` | window_id, x, y | Move window to position |
| `window_resize` | window_id, width, height | Resize window |

## Clipboard

| Action | Parameters | Description |
|--------|-----------|-------------|
| `clipboard_get` | — | Get system clipboard content |
| `clipboard_set` | text | Set system clipboard content |

## Wait Conditions

| Action | Parameters | Description |
|--------|-----------|-------------|
| `wait_for_text` | text, [timeout], [interval] | Wait for text on screen via OCR (default 30s) |
| `wait_for_window` | name, [timeout] | Wait for window with title (default 30s) |

## OCR

| Action | Parameters | Description |
|--------|-----------|-------------|
| `screen_text` | [x], [y], [width], [height], [lang] | OCR on screen or region |

## Layer 1: Playwright Browser Control

> Zero token cost. **Preferred for browser scenarios.** Requires `browser_connect` first.

| Action | Parameters | Description |
|--------|-----------|-------------|
| `browser_click` | selector, [button], [force], [position_x], [position_y] | Click by selector |
| `browser_close_tab` | — | Close current tab |
| `browser_connect` | — | Connect to browser CDP instance |
| `browser_content` | [selector] | Get page text content |
| `browser_cookies_clear` | — | Clear all cookies |
| `browser_cookies_get` | [url_filter] | Get cookies (including HttpOnly) |
| `browser_cookies_set` | cookies | Batch set cookies (JSON array) |
| `browser_eval` | expression | Execute JavaScript expression |
| `browser_fill` | selector, value | Fill form input |
| `browser_frames` | — | List all frames/iframes |
| `browser_get_text` | selector | Get element textContent |
| `browser_goto` | url, [wait_until] | Navigate to URL |
| `browser_links` | [pattern], [max_links] | Extract all page links |
| `browser_main_frame` | — | Switch back to main frame |
| `browser_new_tab` | [url] | Open new tab |
| `browser_reconnect` | — | Force reconnect CDP |
| `browser_screenshot` | [selector], [full_page], [quality], [format] | Playwright screenshot |
| `browser_snapshot` | [interesting_only], [root_selector] | Accessibility snapshot (structured DOM, zero token) |
| `browser_storage_get` | [storage_type] | Get localStorage/sessionStorage |
| `browser_storage_set` | key, value, [storage_type] | Set localStorage/sessionStorage |
| `browser_switch_frame` | [index], [name], [url_contains] | Switch to iframe |
| `browser_switch_tab` | index | Switch to tab |
| `browser_tabs` | — | List all open tabs |
| `browser_url` | — | Get current page URL and title |
| `browser_wait` | selector, [timeout], [state] | Wait for element |
| `browser_wait_network_idle` | [timeout], [idle_time] | Wait for network idle |
| `browser_wait_response` | url_pattern, [timeout] | Wait for matching network response |

## Layer 2: AXTree Semantic Perception

> Zero token cost. Access desktop app semantic structure via accessibility API.

| Action | Parameters | Description |
|--------|-----------|-------------|
| `accessibility_tree` | [app_name], [max_depth], [max_nodes] | Get app accessibility tree |

## Anti-Detection

> L1 extension. Simulate human behavior against bot detection. Requires `browser_connect` first.

| Action | Parameters | Description |
|--------|-----------|-------------|
| `browser_human_click` | selector, [steps], [delay_before_click] | Human-like mouse trajectory click |
| `browser_human_type` | selector, value, [min_char_delay], [max_char_delay] | Human-like character-by-character typing |
| `browser_random_scroll` | [direction], [distance] | Human-like natural scroll |

## Resolution

| Action | Parameters | Description |
|--------|-----------|-------------|
| `set_resolution` | width, height | Adjust virtual display resolution (640-3840 x 480-2160) |

## VNC Live Preview

> VNC/noVNC is **auto-started** by `start_desktop.sh` (port 6080). After desktop starts, run `<preview-skill-directory>/notify 6080` to generate the external URL. These actions are for manual control only.

| Action | Parameters | Description |
|--------|-----------|-------------|
| `vnc_start` | — | Manually start/restart x11vnc + noVNC/websockify (port 6080) |
| `vnc_stop` | — | Stop VNC service |
| `vnc_status` | — | Query VNC service status and port info |

## Audio

| Action | Parameters | Description |
|--------|-----------|-------------|
| `audio_capture` | [duration], [output_name] | Record system audio (default 10s, max 60s) |
| `audio_play` | file_path | Play audio file |

## Screen Recording

| Action | Parameters | Description |
|--------|-----------|-------------|
| `recording_status` | — | Query recording status |
| `start_recording` | [output_name] | Start screen recording (mp4) |
| `stop_recording` | — | Stop recording and return file |

## Legacy Web Navigation

> Prefer L1 `browser_url` and `browser_links` instead. These are fallback when Playwright is unavailable.

| Action | Parameters | Description |
|--------|-----------|-------------|
| `get_browser_url` | — | Infer browser URL from window title |
| `get_page_links` | url, [pattern], [max_links] | Extract page links via curl |
