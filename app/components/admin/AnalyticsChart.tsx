'use client';

import React from 'react';

export interface DataPoint {
  name: string;
  value: number;
  secondary?: number;
  [key: string]: string | number | undefined;
}

export interface AnalyticsChartProps {
  data: DataPoint[];
  title?: string;
  subtitle?: string;
  dataKey?: string;
  secondaryKey?: string;
  height?: number;
  color?: string;
  secondaryColor?: string;
  variant?: 'line' | 'bar';
}

export default function AnalyticsChart({
  data = [],
  title = 'Analytics',
  subtitle,
  dataKey = 'value',
  secondaryKey,
  height = 220,
  color = '#2563eb',
  secondaryColor = '#10b981',
  variant = 'line',
}: AnalyticsChartProps) {
  if (!data || data.length === 0) {
    return (
      <div className='flex items-center justify-center rounded-xl border border-line bg-soft/50 p-6' style={{ height }}>
        <p className='text-xs text-ink-3'>No chart data recorded yet.</p>
      </div>
    );
  }

  const values = data.map((d) => Number(d[dataKey] ?? 0));
  const secValues = secondaryKey ? data.map((d) => Number(d[secondaryKey] ?? 0)) : [];
  const maxVal = Math.max(1, ...values, ...secValues);
  const width = 560;
  const chartH = 150;
  const padL = 34;
  const padR = 14;
  const padT = 14;
  const padB = 26;
  const innerW = width - padL - padR;
  const innerH = chartH - padT - padB;

  const pts = values.map((v, i) => ({
    x: data.length === 1 ? padL + innerW / 2 : padL + (i / (data.length - 1)) * innerW,
    y: padT + innerH - (v / maxVal) * innerH,
    v,
    label: String(data[i].name ?? ''),
  }));
  const linePoints = pts.map((p) => p.x + ',' + p.y).join(' ');

  return (
    <div className='rounded-xl border border-line bg-white p-4 shadow-card'>
      <div className='mb-2 flex items-center justify-between'>
        <div>
          <h3 className='text-xs font-semibold text-ink'>{title}</h3>
          {subtitle && <p className='text-[11px] text-ink-3'>{subtitle}</p>}
        </div>
        <span className='text-[11px] font-medium text-ink-2'>Peak: {maxVal}</span>
      </div>
      <svg viewBox={'0 0 ' + width + ' ' + chartH} className='w-full overflow-visible' style={{ height: height - 48 }}>
        {[0, 0.5, 1].map((s, idx) => {
          const y = padT + innerH * (1 - s);
          return (
            <g key={idx}>
              <line x1={padL} y1={y} x2={width - padR} y2={y} stroke='#e5e7eb' strokeDasharray='3 3' />
              <text x={padL - 5} y={y + 3} textAnchor='end' fontSize='9' fill='#6b7280'>{Math.round(maxVal * s)}</text>
            </g>
          );
        })}
        {variant === 'bar'
          ? pts.map((p, i) => {
              const bw = Math.max(16, Math.min(42, innerW / (data.length * 1.8)));
              const bx = padL + ((i + 0.5) / data.length) * innerW - bw / 2;
              const bh = Math.max(2, (p.v / maxVal) * innerH);
              const by = padT + innerH - bh;
              return (
                <g key={i}>
                  <rect x={bx} y={by} width={bw} height={bh} rx={4} fill={color} />
                  <text x={bx + bw / 2} y={chartH - 6} textAnchor='middle' fontSize='9' fill='#6b7280'>{p.label.slice(0, 10)}</text>
                </g>
              );
            })
          : (
            <>
              <polyline fill='none' stroke={color} strokeWidth={2.2} points={linePoints} />
              {pts.map((p, i) => (
                <g key={i}>
                  <circle cx={p.x} cy={p.y} r={3.5} fill='#fff' stroke={color} strokeWidth={2} />
                  <text x={p.x} y={chartH - 6} textAnchor='middle' fontSize='9' fill='#6b7280'>{p.label.slice(0, 8)}</text>
                </g>
              ))}
            </>
          )}
      </svg>
    </div>
  );
}
