import { Eraser, Trash2, Undo2 } from 'lucide-react';
import type { GameClient } from './GameClient.ts';

export type Tool = { color: string; width: number; eraser: boolean };

const COLORS = [
  '#1f2328', '#868e96', '#e03131', '#f76707', '#fab005',
  '#2f9e44', '#1c7ed6', '#7048e8', '#d6336c', '#8d5524',
];
const WIDTHS = [
  { value: 4, label: '가늘게', dot: 6 },
  { value: 10, label: '보통', dot: 11 },
  { value: 24, label: '굵게', dot: 17 },
];

export function Toolbar({ tool, onChange, client }: { tool: Tool; onChange: (tool: Tool) => void; client: GameClient }) {
  return (
    <div className="toolbar panel" role="toolbar" aria-label="그리기 도구">
      <div className="swatches">
        {COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={`swatch${!tool.eraser && tool.color === color ? ' active' : ''}`}
            style={{ background: color }}
            aria-label={`색 ${color}`}
            aria-pressed={!tool.eraser && tool.color === color}
            onClick={() => onChange({ ...tool, color, eraser: false })}
          />
        ))}
      </div>
      <div className="toolbar-divider" />
      {WIDTHS.map(({ value, label, dot }) => (
        <button
          key={value}
          type="button"
          className={`tool-button${tool.width === value ? ' active' : ''}`}
          aria-label={label}
          aria-pressed={tool.width === value}
          title={label}
          onClick={() => onChange({ ...tool, width: value })}
        >
          <span className="width-dot" style={{ width: dot, height: dot }} />
        </button>
      ))}
      <div className="toolbar-divider" />
      <button
        type="button"
        className={`tool-button${tool.eraser ? ' active' : ''}`}
        aria-label="지우개"
        aria-pressed={tool.eraser}
        title="지우개"
        onClick={() => onChange({ ...tool, eraser: !tool.eraser })}
      >
        <Eraser size={18} />
      </button>
      <button type="button" className="tool-button" aria-label="실행 취소" title="실행 취소 (Ctrl+Z)" onClick={() => client.undo()}>
        <Undo2 size={18} />
      </button>
      <button type="button" className="tool-button" aria-label="모두 지우기" title="모두 지우기" onClick={() => client.clear()}>
        <Trash2 size={18} />
      </button>
    </div>
  );
}
