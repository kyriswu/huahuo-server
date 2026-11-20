import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';

import { matchPromptVariables } from '../../src/modules/ai-templates/prompt-variables.js';

export function PromptEditor({ value, maxLength, onChange }: {
  value: string;
  maxLength: number;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const highlights = useRef<HTMLDivElement>(null);
  const colors = new Map<string, number>();
  const content: ReactNode[] = [];
  let offset = 0;
  for (const { name, start, end } of matchPromptVariables(value)) {
    // Space successive variables around the hue wheel while keeping repeats the same color.
    const hue = colors.get(name) ?? (215 + colors.size * 137.508) % 360;
    colors.set(name, hue);
    content.push(value.slice(offset, start));
    content.push(<mark key={start} style={{ backgroundColor: `hsl(${hue} 80% 88%)` }}>{value.slice(start, end)}</mark>);
    offset = end;
  }
  content.push(value.slice(offset));
  // The textarea reserves a line after the last newline, including when empty.
  if (value.endsWith('\n')) content.push('\u200b');

  function syncScroll() {
    if (highlights.current && textarea.current) highlights.current.scrollTop = textarea.current.scrollTop;
  }
  useLayoutEffect(syncScroll, [value]);

  return (
    <div className="grid min-w-0 gap-1.5">
      <label htmlFor={id} className="font-medium">提示词</label>
      <div className="prompt-editor">
        <div aria-hidden="true" className="prompt-editor-highlights" ref={highlights}>{content}</div>
        <textarea id={id} ref={textarea} aria-describedby={`${id}-hint`} rows={8} maxLength={maxLength}
          value={value} onChange={event => onChange(event.currentTarget.value)} onScroll={syncScroll} />
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs leading-5 text-console-muted">
        <p id={`${id}-hint`}>输入 <code>{'{{变量名}}'}</code> 后自动高亮。</p>
        <span className="ms-auto tabular-nums">{value.length} / {maxLength}</span>
      </div>
    </div>
  );
}
