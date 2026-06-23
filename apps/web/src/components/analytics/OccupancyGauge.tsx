'use client';

import { RadialBarChart, RadialBar, ResponsiveContainer, PolarAngleAxis } from 'recharts';
import { cn } from '@/lib/utils';

interface OccupancyGaugeProps {
  current: number;   // 0-100
  previous: number;  // 0-100
  label?: string;
}

export default function OccupancyGauge({
  current,
  previous,
  label = 'Occupancy Rate',
}: OccupancyGaugeProps) {
  const diff = current - previous;
  const color = current >= 70 ? '#10b981' : current >= 40 ? '#f59e0b' : '#ef4444';

  const data = [{ value: current, fill: color }];

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
      <h3 className="text-base font-semibold text-gray-900 mb-2">{label}</h3>
      <div className="relative flex items-center justify-center">
        <ResponsiveContainer width="100%" height={180}>
          <RadialBarChart
            cx="50%"
            cy="85%"
            innerRadius="70%"
            outerRadius="100%"
            startAngle={180}
            endAngle={0}
            data={data}
          >
            <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
            <RadialBar
              background={{ fill: '#f3f4f6' }}
              dataKey="value"
              cornerRadius={6}
            />
          </RadialBarChart>
        </ResponsiveContainer>
        <div className="absolute bottom-4 flex flex-col items-center">
          <span className="text-3xl font-bold" style={{ color }}>{current}%</span>
          <span className="text-xs text-gray-500 mt-1">This Month</span>
        </div>
      </div>
      <div className="flex items-center justify-between mt-2 text-sm">
        <span className="text-gray-500">Last month: {previous}%</span>
        <span className={cn('font-medium', diff >= 0 ? 'text-emerald-600' : 'text-red-500')}>
          {diff >= 0 ? '+' : ''}{diff}%
        </span>
      </div>
      <div className="mt-3 flex gap-2 text-xs text-gray-500">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-400 inline-block" /> {'<'}40% Low</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400 inline-block" /> 40–70% Mid</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" /> {'>'}70% Good</span>
      </div>
    </div>
  );
}
