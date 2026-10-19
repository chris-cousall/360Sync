# 360Sync

Lightweight desktop video player (flat + 360° equirectangular) with a synced motorsport time/distance chart.

## Run

```
npm install
npm start          # run from source
npm run dist       # build portable Windows .exe into dist/
npm run installer  # also build dist/360Sync-Setup-<version>.exe
```

The installer installs for the current user, so it doesn't need admin rights. It lets you choose the folder, and adds Start menu and desktop shortcuts. It also registers `.360sync` files, so double-clicking a project opens it in 360Sync, or in the window that's already open. Uninstall it from Windows Settings → Apps. The portable build in `dist/360Sync` doesn't register file types.

## Use

1. **Open Video** (or drag & drop). 2:1 videos switch to 360° automatically; toggle Flat/360° manually if needed. In 360°: drag to look, wheel to zoom, double-click to reset.
2. **Open Data** (or drag & drop) a telemetry CSV. Time, distance and default channels (speed, throttle, brake, RPM, gear, steering) are auto-detected; change them in the left panel. A **Columns** table opens on load, showing each column's name in the file, its range, and editable **Name** and **Unit** fields. Renames are remembered by the original column name, so the same export comes in renamed next time. Reopen it with **✎ Rename columns**, or untick *Show when loading data* to skip it.
3. **Sync:** put the video on a recognisable moment (e.g. lights out, a braking point), click the matching point on the chart, press **Sync** (or `S`). The chart cursor now follows the video, and clicking/dragging on the chart seeks the video.
4. Fine-tune with **−/+** (`[` `]` = 1 frame, Shift or `{` `}` = 0.1 s). Sync is remembered per video+data pair.

**⏱ Overlay** shows an F1-style dial over the video (speed band with scale badges, throttle and brake arcs, DRS indicator, rolling gear counter, RPM and speed) for the moment under the chart cursor. In the Overlay panel, pick which channel drives each gauge (auto-detected by name; choose (none) to hide a gauge), set the speed scale or leave it on auto, and adjust size and opacity. Drag the dial to move it and scroll over it to resize. Throttle in 0–1 or %, and brake scaled to the file's peak pressure, are handled automatically. Under **Display → Style**, switch between the **F1 dial** and a **Classic gauge** (analog rev counter with needle, Gear/Throttle/Brake tags and a segmented speed bar, with a matching driver tag), and a **Modern wheel** (steering-wheel display with a blue/red rev arc, big yellow speed, rolling gear strip, Throttle/Brake bars), a **McLaren pod** (carbon face with a papaya rev ring, 3 green / 3 red / 3 purple shift lights, throttle and brake arcs, big centre gear, speed below it, and a driver tag with the McLaren speedmark in place of the number), and a **Pedal trace** strip in the same McLaren style (carbon plate with rolling 5-second throttle/brake/clutch traces in green/red/yellow on a slanted grid, slanted pedal bars with percentages, and a round badge with the papaya rev ring, shift lights, gear and speed). The clutch trace is hidden wherever clutch is under 1%. The channel choices stay the same; map a **Clutch** channel for the yellow trace. Point the **Pit limiter** channel at a pit-limiter switch and set the **Pit speed limit**: while it is on, each style flashes a pit limiter warning and shows speed in amber, turning red over the limit. If the data has no pit limiter channel, use **🚦 Manual pit lane…** in the Overlay panel to mark the zones yourself: add a From and To video time for each pit lane pass, typing them or using **Current frame**. They're saved per video and in projects, and they're included in exports. Tick **Show driver plate** to add a slanted name plate under the dial with the driver's name, car number, team colour and flag. Pick from built-in flags, or use **Custom flag image…** to load your own flag or logo.

**Placement, lock and templates.** The overlay, driver plate and lap box are positioned and sized relative to the video picture, not the window. Resizing the window scales them with the video, and they always stay inside the frame, so what you see is what gets exported. Tick **🔒 Lock position & size** in the Overlay panel so they can't be dragged or resized by accident. While locked, clicks pass through to the video, so you can still look around in 360°. Under **Template**, type a name and press **Save** to store the current style, sizes, positions, display options and driver details. The channel mapping is not saved, because it depends on the data file. Pick a template from the list to apply it to any video. Applying a template also locks it, so a series of exports all look the same. Saving with an existing name overwrites that template. **Export…** saves the selected template as a `.360tpl` file, so you can share it or use it on another PC. **Import…** adds the templates from a `.360tpl` file. If the file holds a single template, it is applied straight away.

**About.** **Project ▸ About 360Sync** shows the version.

### Analyse / Edit
The switch at the top left picks the workspace:
- **Analyse** shows the video, the overlay and the telemetry chart. The driver plate is hidden here.
- **Edit** hides the chart and shows the video with the overlay and the driver plate. It adds **Lap trigger** and **⤓ Export MP4**.

**Lap trigger** adds lap time boxes, saved per video. Set the trigger at a video time (or use **Current frame**), then enter the lap time and, optionally, the delta. Type the lap time as digits only (`132456` becomes `1:32.456`). Leave the delta blank and it is worked out from the fastest lap: slower laps show how far off it they are (red), and the fastest lap shows how far ahead of the next best it is (purple). A typed delta overrides this. From that frame a box styled like the McLaren name plate wipes in. It shows LAP n, the lap time and the delta (purple when negative, red when positive), holds for 10 s, then wipes out. Lap boxes show in both Analyse and Edit. To place the box, open the Lap trigger dialog (or **⏱ Overlay** before any laps are set): while it is open and the video is paused, a full preview of the box is shown with a green dotted outline (not when locked, and not exported). Otherwise, playing or scrubbing, it only appears at its triggers, so with laps set you can scrub to one to move it. Drag it to move it, scroll over it to resize, or double-click it to reset. The panel's **Lap time box** section also has a show/hide switch, a size slider and **Reset box position**. With the **McLaren pod** and **Pedal trace** styles the driver plate is a separate box too: drag it anywhere, or double-click it to snap it back under the overlay. Both boxes are included in exports.

**Trim** (Edit only): **[ In** (`I`) and **Out ]** (`O`) set the clip's start and end at the playhead. On the seek bar, the trimmed-off parts are shaded and the amber brackets can be dragged. Playback starts at the in point and stops at the out point. The export dialog defaults to the trimmed clip. **✕** clears the trim. Trims are saved per video and in projects.

**360 view keyframes** (Edit only, 360° mode) move the camera in the exported video, like the Insta360 app:
- Move the playhead, aim the view (drag to turn, scroll to zoom) and press **◆ Keyframe** (`K`). Keyframes show as diamonds on the seek bar.
- Between keyframes the view moves smoothly. It takes the shorter way round, eases out of the first keyframe and into the last, and doesn't overshoot. Two keyframes with the same view make it hold still.
- While paused you can aim freely. The button turns amber when the view differs from the keyframed path; press it to add a keyframe, or to update the one under the playhead.
- Click a diamond to jump to it, drag it to retime it, or right-click it to delete it. **⟨◆ / ◆⟩** jump between keyframes. **✕** deletes the keyframe at the playhead, and Shift-click deletes them all.
- Playback and the export follow the keyframes. Analyse mode ignores them so you can look around freely.

**Export MP4** renders the video with the overlay into an MP4, using hardware encoding when the system supports it.
- Pick the resolution: Source (flat video only), 720p, 1080p, 1440p or 2160p. Unwrapped 360° video also offers 2880p (5760 × 2880), which needs H.265.
  - The overlay is drawn at the export resolution. On a high-DPI screen the app shows it with more pixels than a 1080p file has, so a 1080p export looks softer full screen.
  - The first time you export, the dialog picks a size that matches the preview. It warns you when the chosen size is smaller.
  - Exporting a 1080p video at 1440p or 2160p keeps the overlay crisp, although the video itself gets no sharper.
- **Quality** sets the bitrate: Standard, High (the default) or Maximum. Maximum keeps the most detail in fast motion, grass and gravel, and makes the largest files.
- **Codec:**
  - **H.264** plays almost anywhere.
  - **H.265 / HEVC** is sharper at the same file size and supports bigger frames, but it needs a GPU that can encode it. If this PC can't, it is greyed out.
  - The dialog shows the bitrate and the approximate file size before you export.
- Pick the range: the trimmed clip (the default when a trim is set), the whole video, the span covered by the telemetry, or a custom start and end.
- Or pick **Each lap** to export one MP4 per lap trigger (`name_Lap01.mp4`, `name_Lap02.mp4`, …).
  - A lap runs back from its trigger by its lap time.
  - Add a lead-in before each lap and a run-out after it. The default run-out of 11 s lets the lap time box play out in full.
  - Untick laps you don't want. Laps that fall outside the video are skipped.
- The original AAC audio is copied in when you include audio.
- 360° and .insv video export as the current view (direction and zoom), or follow the view keyframes when there are any.
- The overlay keeps the position and size it has on screen.

### Projects
**📁 Project** saves everything about a job to a `.360sync` file:
- the video and data files
- column names and channel choices
- sync, the 360 view and stitching settings
- overlay style and position, lap boxes, pit zones, trim and view keyframes
- mode and playhead

Use **Save** (`Ctrl+S`), **Save as…** (`Ctrl+Shift+S`) and **Open** (`Ctrl+O`). You can also drag a `.360sync` file onto the window or open one with 360Sync.

File locations are stored both absolute and relative to the project file, so a folder can be moved or copied to another PC as a whole. If a file still can't be found, you're asked to locate it.

X axis can be **Time** or **Distance** (from a distance column — lap distance resets are stitched — or integrated from speed).

### Keys
Space play/pause · ←/→ frame step (Shift = 1 s) · S sync · [ ] nudge · L lock 360 view · K add view keyframe · I / O trim in / out (Edit) · Ctrl+O / Ctrl+S / Ctrl+Shift+S open / save / save project as

### Chart
Click/drag = move cursor · wheel = zoom · right-drag / Shift-drag = pan · double-click = fit.

## Data formats

Native `.ssn` (ATLAS), Pi Toolbox and `.ld` (MoTeC) files are proprietary — export to CSV/text first:

- **MoTeC i2:** File → Export → CSV.
- **McLaren ATLAS:** export the session/lap to CSV (time as seconds or hh:mm:ss.fff).
- **Pi Toolbox:** export ASCII/CSV (tab or comma delimited).

The importer handles comma/tab/semicolon delimiters, metadata blocks above the header, a separate units row or `Name [unit]` headers, s/ms/µs/ns time columns (auto-guessed, overridable), blank cells from mixed-rate exports, and text states (YES/NO, ON/OFF, TRUE/FALSE read as 1/0; gear N as 0 and R as −1). Files without a header row get columns named Column 1, Column 2, … which you can rename on import.

## Video formats

Anything Chromium decodes: H.264/H.265 MP4, MOV, WebM.

**Insta360 `.insv`** files open directly, with no export step. Both fisheye streams are decoded with hardware HEVC and stitched live on the GPU using the camera's own lens calibration (tested with an X4 Air). The seam is stitched dynamically: on every frame the lens images are matched along the seam to find each object's distance, so nearby things like the car's nose and people in the pit lane line up instead of ghosting. Small exposure differences between the lenses are evened out as well. In 360° mode the view is shown at 16:9.

The **⚙ Stitching** panel beside the video (Insta360 files only) has: stitching mode (**Dynamic**, **Fixed distance** with a distance slider, or **Off** = lens calibration only), **Fusion angle** (crossfade width at the seam: narrower is sharper, wider hides misalignment), **Colour match**, **Sharpen**, **Defringe** (removes purple/blue fringes around bright edges), and **Show seam** to highlight where the lenses join. Settings are remembered. Drag to look around and scroll to zoom. The view direction is remembered per file, so you only need to aim it at the car's forward direction once. Once it's aimed, press **🔒 Lock** (or L) to lock the orientation and zoom so it can't be knocked by accident; the lock is remembered per file. Notes:
- This needs a GPU with HEVC decode, which most PCs from 2016 onward have.
- `.lrv` proxies play unstitched.
- Files where the camera recorded each lens to a separate file (`_00_` + `_10_`) are not supported.
- No gyro stabilisation is applied.

Other camera-native formats (GoPro `.360`) still need exporting to an equirectangular MP4 first.
