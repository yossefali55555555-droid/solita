import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DeliveryStatusBadge, ReviewStatusBadge, SourceStatusBadge } from './StatusBadges.jsx';

describe('status badges', () => {
  it('keeps source, delivery and review statuses visibly distinct', () => {
    render(
      <>
        <SourceStatusBadge status="delivered" />
        <DeliveryStatusBadge status="pending_delivery_review" />
        <ReviewStatusBadge status="pending" />
      </>,
    );
    expect(screen.getByText('EasyOrders:')).toBeInTheDocument();
    expect(screen.getByText('التوصيل:')).toBeInTheDocument();
    expect(screen.getByText('المراجعة:')).toBeInTheDocument();
  });

  it('renders customer-provided text safely as text', () => {
    const { container } = render(<SourceStatusBadge status={'<img src=x onerror=alert(1)>'} />);
    expect(container.querySelector('img')).toBeNull();
  });
});
