'use client';

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

interface LazyLineChartProps {
  data: Array<{
    month: string;
    earnings: number;
    bookings: number;
  }>;
}

export function LazyLineChart({ data }: LazyLineChartProps) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="month" />
        <YAxis yAxisId="earnings" />
        <YAxis yAxisId="bookings" orientation="right" />
        <Tooltip />
        <Legend />
        <Line
          yAxisId="earnings"
          type="monotone"
          dataKey="earnings"
          stroke="#3b82f6"
          name="Earnings (USDC)"
          strokeWidth={2}
        />
        <Line
          yAxisId="bookings"
          type="monotone"
          dataKey="bookings"
          stroke="#10b981"
          name="Bookings"
          strokeWidth={2}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
