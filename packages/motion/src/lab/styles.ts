export const LAB_CSS = `
.ithaca-lab {
  --bg: #12100e; --panel: #1c1916; --line: #34302a; --text: #ece6d8; --muted: #9a917f;
  --ok: #52b788; --warn: #e9c46a; --bad: #e76f51; --accent: #f8961e;
  font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--text); background: var(--bg); min-height: 100vh; padding: 12px 16px; box-sizing: border-box;
}
.ithaca-lab * { box-sizing: border-box; }
.ithaca-lab header { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 8px; }
.ithaca-lab h1 { font-size: 18px; margin: 0 12px 0 0; letter-spacing: .02em; }
.ithaca-lab h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted);
  margin: 12px 0 6px; display: flex; align-items: center; gap: 8px; }
.ithaca-lab .badge { padding: 2px 8px; border-radius: 999px; background: var(--panel); border: 1px solid var(--line);
  font-variant-numeric: tabular-nums; }
.ithaca-lab .badge[data-level="ok"] { border-color: var(--ok); color: var(--ok); }
.ithaca-lab .badge[data-level="warn"] { border-color: var(--warn); color: var(--warn); }
.ithaca-lab .badge[data-level="bad"] { border-color: var(--bad); color: var(--bad); }
.ithaca-lab .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
.ithaca-lab button, .ithaca-lab select { font: inherit; color: var(--text); background: var(--panel);
  border: 1px solid var(--line); border-radius: 6px; padding: 5px 10px; cursor: pointer; }
.ithaca-lab button:hover:not(:disabled) { border-color: var(--accent); }
.ithaca-lab button:disabled { opacity: .45; cursor: default; }
.ithaca-lab button.primary { background: var(--accent); color: #1a1208; border-color: var(--accent); font-weight: 600; }
.ithaca-lab button.small { padding: 0 6px; font-size: 11px; }
.ithaca-lab button.on { background: var(--bad); color: #fff; border-color: var(--bad); }
.ithaca-lab .error { color: var(--bad); }
.ithaca-lab main { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 14px; }
@media (max-width: 900px) { .ithaca-lab main { grid-template-columns: 1fr; } }
.ithaca-lab .stage-wrap { position: relative; background: #000; border-radius: 8px; overflow: hidden;
  aspect-ratio: 16 / 9; align-self: start; }
.ithaca-lab .stage { position: absolute; inset: 0; transform: scaleX(-1); /* selfie view */ }
.ithaca-lab .stage video, .ithaca-lab .stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
.ithaca-lab .placeholder { position: absolute; inset: 0; display: grid; place-items: center; color: var(--muted); }
.ithaca-lab .placeholder[hidden] { display: none; }
.ithaca-lab .ring { position: absolute; top: 12px; left: 12px; width: 72px; height: 72px; border-radius: 50%;
  display: grid; place-items: center; font-size: 10px; text-align: center; font-weight: 600;
  background: conic-gradient(var(--accent) calc(var(--p) * 1turn), #0008 0); }
.ithaca-lab .ring span { background: #000c; border-radius: 50%; width: 58px; height: 58px; display: grid; place-items: center; }
.ithaca-lab .ring[hidden] { display: none; }
.ithaca-lab .calib { position: absolute; left: 0; right: 0; bottom: 0; padding: 12px 16px; background: #000b;
  font-size: 18px; font-weight: 600; text-align: center; }
.ithaca-lab .calib[hidden] { display: none; }
.ithaca-lab .calib progress { width: 60%; display: block; margin: 6px auto 0; }
.ithaca-lab aside { min-width: 0; }
.ithaca-lab pre { margin: 0; padding: 8px; background: var(--panel); border-radius: 6px; max-height: 280px;
  overflow: auto; font: 11px/1.35 ui-monospace, Menlo, Consolas, monospace; }
.ithaca-lab .log { list-style: none; margin: 0; padding: 6px 8px; background: var(--panel); border-radius: 6px;
  max-height: 220px; overflow: auto; font: 11px/1.5 ui-monospace, Menlo, Consolas, monospace; }
.ithaca-lab .log time { color: var(--muted); }
.ithaca-lab .log b { color: var(--accent); }
.ithaca-lab canvas.space { width: 100%; height: auto; background: var(--panel); border-radius: 6px; display: block; }
.ithaca-lab .sliders { display: grid; grid-template-columns: 1fr; gap: 2px; max-height: 360px; overflow: auto;
  background: var(--panel); border-radius: 6px; padding: 6px 8px; }
.ithaca-lab .sliders label { display: grid; grid-template-columns: 150px 1fr 56px; gap: 6px; align-items: center; font-size: 11px; }
.ithaca-lab .sliders output { font-variant-numeric: tabular-nums; text-align: right; }
.ithaca-lab .sliders label.changed span { color: var(--accent); }
.ithaca-lab .below { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; margin-top: 4px; }
.ithaca-lab .sliders h3 { font-size: 11px; margin: 8px 0 2px; color: var(--muted); font-weight: 600; }
.ithaca-lab .sliders .row { margin-top: 8px; display: flex; gap: 6px; }
.ithaca-lab small { text-transform: none; letter-spacing: 0; font-weight: 400; }
`;
