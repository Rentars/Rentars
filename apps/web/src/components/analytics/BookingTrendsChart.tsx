'use client';

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Cell,
} from 'recharts';

interface TrendPoint {
  label: string;
  bookings: number;
  earnings?: number;
}

interface BookingTrendsChartProps {
  data: TrendPoint[];
  title?: string;
}

const CustomTooltip = ({ active, payload, label }: {
  active?: boolean;
  payload?: { name: string; value: number }[];
  label?: string;
}) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-3 shadow-lg text-sm">
      <p className="font-semibold text-gray-700 mb-1">{label}</p>
      {payload.map((p) => (
        <p key={p.name} className="text-gray-600">
          {p.name}: <span className="font-medium text-gray-900">{p.value}</span>
        </p>
      ))}
    </div>
  );
};

export default function BookingTrendsChart({ data, title = 'Booking Trends' }: BookingTrendsChartProps) {
  const chartData = data.slice(-6).map(d => ({
    ...d,
    label: d.label.replace(/\s\d{4}$/, ''),
  }));

  const maxBookings = Math.max(...chartData.map(d => d.bookings), 1);

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
      <h3 className="text-base font-semibold text-gray-900 mb-4">{title}</h3>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#6b7280' }} tickLine={false} axisLine={false} />
          <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: '#6b7280' }} tickLine={false} axisLine={false} />
          <Tooltip content={<CustomTooltip />} cursor={{ fill: '#f9fafb' }} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="bookings" name="Bookings" radius={[4, 4, 0, 0] as [number, number, number, number]}>
            {chartData.map((entry, index) => (
              <Cell
                key={`cell-${index}`}
                fill={entry.bookings === maxBookings ? '#3b82f6' : '#93c5fd'}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
