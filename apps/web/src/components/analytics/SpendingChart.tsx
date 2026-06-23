'use client';

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
} from 'recharts';
import type { TenantBookingStat } from '@/hooks/useTenantAnalytics';

interface SpendingChartProps {
  data: TenantBookingStat[];
  title?: string;
}

const CustomTooltip = ({ active, payload, label }: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
}) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-3 shadow-lg text-sm">
      <p className="font-semibold text-gray-700 mb-1">{label}</p>
      {payload.map((p) => (
        <p key={p.name} style={{ color: p.color }}>
          {p.name}: {p.name === 'Spent' ? `${p.value.toFixed(2)} USDC` : p.value}
        </p>
      ))}
    </div>
  );
};

export default function SpendingChart({ data, title = 'Monthly Spending' }: SpendingChartProps) {
  const chartData = data.slice(-6).map(d => ({
    ...d,
    label: d.label.replace(/\s\d{4}$/, ''),
  }));

  const avgSpent = chartData.length > 0
    ? chartData.reduce((s, d) => s + d.spent, 0) / chartData.length
    : 0;

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
      <h3 className="text-base font-semibold text-gray-900 mb-4">{title}</h3>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#6b7280' }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 12, fill: '#6b7280' }} tickLine={false} axisLine={false} />
          <Tooltip content={<CustomTooltip />} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {avgSpent > 0 && (
            <ReferenceLine
              y={avgSpent}
              stroke="#d1d5db"
              strokeDasharray="4 4"
              label={{ value: 'Avg', position: 'right', fontSize: 11, fill: '#9ca3af' }}
            />
          )}
          <Line
            type="monotone"
            dataKey="spent"
            name="Spent"
            stroke="#8b5cf6"
            strokeWidth={2.5}
            dot={{ r: 4, fill: '#8b5cf6' }}
            activeDot={{ r: 6 }}
          />
          <Line
            type="monotone"
            dataKey="bookings"
            name="Bookings"
            stroke="#06b6d4"
            strokeWidth={2}
            dot={{ r: 3, fill: '#06b6d4' }}
            strokeDasharray="4 2"
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
