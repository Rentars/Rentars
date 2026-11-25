'use client';

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

interface LazyChartProps {
  data: Array<{
    month: string;
    spent: number;
  }>;
}

export function LazyChart({ data }: LazyChartProps) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="month" />
        <YAxis />
        <Tooltip />
        <Legend />
        <Bar dataKey="spent" fill="#3b82f6" name="USDC Spent" />
      </BarChart>
    </ResponsiveContainer>
  );
}
