import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/tests/utils/test-utils';
import userEvent from '@testing-library/user-event';
import StarRating from '../StarRating';

describe('StarRating', () => {
  it('renders 5 stars by default', () => {
    render(<StarRating rating={0} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(5);
  });

  it('renders correct number of stars with custom max', () => {
    render(<StarRating rating={0} max={3} />);
    expect(screen.getAllByRole('button')).toHaveLength(3);
  });

  it('disables buttons when not interactive', () => {
    render(<StarRating rating={3} interactive={false} />);
    const buttons = screen.getAllByRole('button');
    buttons.forEach((btn) => expect(btn).toBeDisabled());
  });

  it('enables buttons when interactive', () => {
    render(<StarRating rating={3} interactive={true} onChange={vi.fn()} />);
    const buttons = screen.getAllByRole('button');
    buttons.forEach((btn) => expect(btn).not.toBeDisabled());
  });

  it('calls onChange with correct rating when star is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<StarRating rating={0} interactive onChange={onChange} />);

    const buttons = screen.getAllByRole('button');
    await user.click(buttons[2]); // click 3rd star
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it('calls onChange with 1 when first star is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<StarRating rating={0} interactive onChange={onChange} />);

    await user.click(screen.getAllByRole('button')[0]);
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it('calls onChange with max when last star is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<StarRating rating={0} interactive onChange={onChange} />);

    const buttons = screen.getAllByRole('button');
    await user.click(buttons[buttons.length - 1]);
    expect(onChange).toHaveBeenCalledWith(5);
  });

  it('clamps ratings below zero to no filled stars', () => {
    const { container } = render(<StarRating rating={-1} max={5} />);
    expect(container.querySelectorAll('svg.fill-yellow-400')).toHaveLength(0);
  });

  it('clamps ratings above max to the maximum number of filled stars', () => {
    const { container } = render(<StarRating rating={8} max={5} />);
    expect(container.querySelectorAll('svg.fill-yellow-400')).toHaveLength(5);
  });

  it('preserves valid ratings within the configured range', () => {
    const { container } = render(<StarRating rating={3} max={5} />);
    expect(container.querySelectorAll('svg.fill-yellow-400')).toHaveLength(3);
  });

  it('applies filled styling to stars below or equal to rating', () => {
    const { container } = render(<StarRating rating={3} />);
    // Stars 1-3 should be filled (yellow), 4-5 should be empty (gray)
    const svgs = container.querySelectorAll('svg');
    expect(svgs[0]).toHaveClass('fill-yellow-400');
    expect(svgs[2]).toHaveClass('fill-yellow-400');
    expect(svgs[3]).toHaveClass('text-gray-300');
    expect(svgs[4]).toHaveClass('text-gray-300');
  });
});
