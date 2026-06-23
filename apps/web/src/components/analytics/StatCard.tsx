'use client';

import { type LucideIcon, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  growth?: number;       // percentage, positive = up, negative = down
  icon: LucideIcon;
  iconColor?: string;
  gradientFrom?: string;
  gradientTo?: string;
  variant?: 'default' | 'gradient';
}

export default function StatCard({
  title,
  value,
  subtitle,
  growth,
  icon: Icon,
  iconColor = 'text-blue-600',
  gradientFrom = 'from-blue-50',
  gradientTo = 'to-blue-100',
  variant = 'default',
}: StatCardProps) {
  const hasGrowth = growth !== undefined && growth !== null;

  const GrowthIcon = !hasGrowth ? null : growth > 0 ? TrendingUp : growth < 0 ? TrendingDown : Minus;
  const growthColor = !hasGrowth ? '' : growth > 0 ? 'text-emerald-600' : growth < 0 ? 'text-red-500' : 'text-gray-500';

  if (variant === 'gradient') {
    return (
      <div className={cn('rounded-xl p-5 border shadow-sm bg-gradient-to-br', gradientFrom, gradientTo, 'border-blue-200')}>
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-medium text-blue-700">{title}</p>
          <Icon size={20} className={iconColor} />
        </div>
        <p className="text-3xl font-bold text-gray-900">{value}</p>
        {subtitle && <p className="text-sm text-blue-700 mt-1">{subtitle}</p>}
        {hasGrowth && GrowthIcon && (
          <div className={cn('flex items-center gap-1 mt-2 text-sm font-medium', growthColor)}>
            <GrowthIcon size={14} />
            <span>{growth > 0 ? '+' : ''}{growth}% vs last month</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-medium text-gray-500">{title}</p>
        <div className={cn('p-2 rounded-lg bg-gray-50', iconColor)}>
          <Icon size={18} />
        </div>
      </div>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      {subtitle && <p className="text-sm text-gray-500 mt-1">{subtitle}</p>}
      {hasGrowth && GrowthIcon && (
        <div className={cn('flex items-center gap-1 mt-2 text-sm font-medium', growthColor)}>
          <GrowthIcon size={14} />
          <span>{growth > 0 ? '+' : ''}{growth}% vs last month</span>
        </div>
      )}
    </div>
  );
}
