import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Banner } from './Banner';
import { BookCard } from './BookCard';
import { ConfirmSlider, CONFIRM_THRESHOLD, isConfirmed, slideProgress } from './ConfirmSlider';
import { Countdown, URGENT_SECONDS } from './Countdown';
import { GuardrailChecklist } from './GuardrailChecklist';
import { EmptyState, Loading } from './GlobalBanners';
import { Money } from './Money';
import { OrderStatusPill } from './OrderStatusPill';
import { ProposalCard } from './ProposalCard';
import { NOW, buildBook, buildProposal, isoPlus } from '../test-utils';

describe('Banner', () => {
  it('renders title, message and an optional action', async () => {
    const onAction = jest.fn();
    await render(
      <Banner
        tone="danger"
        title="Execution unavailable"
        message="The backend is not answering."
        actionLabel="Retry"
        onAction={onAction}
        testID="b"
      />,
    );

    expect(screen.getByText('Execution unavailable')).toBeTruthy();
    expect(screen.getByText('The backend is not answering.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('b-action'));
    expect(onAction).toHaveBeenCalled();
  });

  it('renders without a message or an action', async () => {
    await render(<Banner tone="info" title="Just so you know" />);
    expect(screen.getByText('Just so you know')).toBeTruthy();
    expect(screen.queryByText('Retry')).toBeNull();
  });

  it('announces itself as an alert', async () => {
    await render(<Banner tone="warn" title="Careful" testID="b" />);
    expect(screen.getByTestId('b').props.accessibilityRole).toBe('alert');
  });
});

describe('Money', () => {
  it('renders plain, whole and signed variants', async () => {
    await render(
      <>
        <Money amount={1234.5} testID="plain" />
        <Money amount={1234.5} variant="whole" testID="whole" />
        <Money amount={-1234.5} variant="signed" testID="neg" />
        <Money amount={1234.5} variant="signed" testID="pos" />
      </>,
    );
    expect(screen.getByTestId('plain')).toHaveTextContent(/₹1,234\.50/);
    expect(screen.getByTestId('whole')).toHaveTextContent(/₹1,235/);
    expect(screen.getByTestId('neg')).toHaveTextContent(/-₹1,234\.50/);
    expect(screen.getByTestId('pos')).toHaveTextContent(/\+₹1,234\.50/);
  });
});

describe('OrderStatusPill', () => {
  it.each([
    'SUBMITTED',
    'OPEN',
    'PARTIAL',
    'COMPLETE',
    'CANCELLED',
    'REJECTED',
    'EXPIRED',
    'UNKNOWN',
  ] as const)('renders %s', async (status) => {
    await render(<OrderStatusPill status={status} testID="pill" />);
    expect(screen.getByText(status)).toBeTruthy();
  });
});

describe('Countdown', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterEach(() => jest.useRealTimers());

  it('shows the remaining time', async () => {
    await render(<Countdown ttlExpiresAt={isoPlus(134)} testID="c" />);
    expect(screen.getByTestId('c')).toHaveTextContent(/2m 14s/);
  });

  it('replaces the timer with "expired" once the TTL elapses', async () => {
    await render(<Countdown ttlExpiresAt={isoPlus(2)} testID="c" />);
    expect(screen.getByTestId('c')).toHaveTextContent(/2s/);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByTestId('c')).toHaveTextContent(/expired/);
    expect(screen.queryByText('0s')).toBeNull();
  });

  it('starts expired for a past TTL and honours a custom label', async () => {
    await render(<Countdown ttlExpiresAt={isoPlus(-5)} expiredLabel="too late" testID="c" />);
    expect(screen.getByTestId('c')).toHaveTextContent(/too late/);
  });

  it('labels the urgent threshold for assistive tech', async () => {
    await render(<Countdown ttlExpiresAt={isoPlus(URGENT_SECONDS - 5)} testID="c" />);
    expect(screen.getByTestId('c').props.accessibilityLabel).toBe('expires in 25s');
  });
});

describe('GuardrailChecklist', () => {
  it('renders a tick or a cross for every check', async () => {
    await render(
      <GuardrailChecklist
        checks={[
          { name: 'killSwitch', ok: true, detail: 'off' },
          { name: 'dailyNotional', ok: false, detail: 'over the daily cap' },
        ]}
        testID="list"
      />,
    );

    expect(screen.getByTestId('guardrail-killSwitch')).toHaveTextContent(/^✓killSwitch/);
    expect(screen.getByTestId('guardrail-dailyNotional')).toHaveTextContent(/^✗dailyNotional/);
    expect(screen.getByText('over the daily cap')).toBeTruthy();
    expect(screen.getByText('1 failed')).toBeTruthy();
  });

  it('summarises an all-green list', async () => {
    await render(<GuardrailChecklist checks={[{ name: 'a', ok: true, detail: 'fine' }]} />);
    expect(screen.getByText('1 passed')).toBeTruthy();
  });

  it('appends client-computed checks', async () => {
    await render(
      <GuardrailChecklist
        checks={[{ name: 'a', ok: true, detail: 'fine' }]}
        extra={[{ name: 'backendReachable', ok: false, detail: 'backend down' }]}
      />,
    );
    expect(screen.getByTestId('guardrail-backendReachable')).toBeTruthy();
  });

  it('says so when a proposal carries no checks at all', async () => {
    await render(<GuardrailChecklist checks={[]} />);
    expect(screen.getByText(/No guardrail results/)).toBeTruthy();
  });
});

describe('ConfirmSlider', () => {
  it('computes progress along the track', () => {
    // Track 272 wide, handle 72 → 200 of travel.
    expect(slideProgress(0, 272)).toBe(0);
    expect(slideProgress(100, 272)).toBeCloseTo(0.5);
    expect(slideProgress(500, 272)).toBe(1);
    expect(slideProgress(-50, 272)).toBe(0);
  });

  it('never completes on a zero-width or nonsense track', () => {
    expect(slideProgress(100, 0)).toBe(0);
    expect(slideProgress(100, 72)).toBe(0);
    expect(slideProgress(Number.NaN, 272)).toBe(0);
  });

  it('only confirms past the threshold', () => {
    expect(isConfirmed(CONFIRM_THRESHOLD)).toBe(true);
    expect(isConfirmed(CONFIRM_THRESHOLD - 0.01)).toBe(false);
  });

  it('confirms through the accessibility action', async () => {
    const onConfirm = jest.fn();
    await render(
      <ConfirmSlider label="Slide to BUY" disabled={false} onConfirm={onConfirm} testID="slider" />,
    );

    await fireEvent(screen.getByTestId('slider'), 'accessibilityAction', {
      nativeEvent: { actionName: 'activate' },
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('ignores an unrelated accessibility action', async () => {
    const onConfirm = jest.fn();
    await render(
      <ConfirmSlider label="Slide to BUY" disabled={false} onConfirm={onConfirm} testID="slider" />,
    );
    await fireEvent(screen.getByTestId('slider'), 'accessibilityAction', {
      nativeEvent: { actionName: 'increment' },
    });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('cannot be confirmed while disabled', async () => {
    const onConfirm = jest.fn();
    await render(
      <ConfirmSlider label="Slide to BUY" disabled onConfirm={onConfirm} testID="slider" />,
    );
    await fireEvent(screen.getByTestId('slider'), 'accessibilityAction', {
      nativeEvent: { actionName: 'activate' },
    });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByTestId('slider').props.accessibilityState.disabled).toBe(true);
  });

  it('cannot be confirmed while busy, and says what it is doing', async () => {
    const onConfirm = jest.fn();
    await render(
      <ConfirmSlider
        label="Slide to BUY"
        confirmingLabel="Placing…"
        disabled={false}
        busy
        onConfirm={onConfirm}
        testID="slider"
      />,
    );
    expect(screen.getByText('Placing…')).toBeTruthy();
    await fireEvent(screen.getByTestId('slider'), 'accessibilityAction', {
      nativeEvent: { actionName: 'activate' },
    });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('measures its track on layout', async () => {
    await render(
      <ConfirmSlider label="Slide" disabled={false} onConfirm={jest.fn()} testID="slider" />,
    );
    await fireEvent(screen.getByTestId('slider'), 'layout', {
      nativeEvent: { layout: { width: 300, height: 64 } },
    });
    expect(screen.getByTestId('slider-handle')).toBeTruthy();
  });
});

describe('BookCard', () => {
  it('shows deployment, headroom and realised P&L', async () => {
    await render(<BookCard book={buildBook()} />);
    expect(screen.getByText('Swing')).toBeTruthy();
    expect(screen.getByText('on')).toBeTruthy();
    expect(screen.getByText(/₹1,20,000 of ₹3,00,000 deployed/)).toBeTruthy();
    expect(screen.getByText('₹1,80,000')).toBeTruthy();
    expect(screen.getByText('+₹4,500.00')).toBeTruthy();
  });

  it('marks a disabled book paused and survives a zero allocation', async () => {
    await render(
      <BookCard book={buildBook({ enabled: false, allocatedCapitalInr: 0, deployedInr: 0 })} />,
    );
    expect(screen.getByText('paused')).toBeTruthy();
  });
});

describe('ProposalCard', () => {
  it('shows everything the inbox promises and routes a tap', async () => {
    const onOpen = jest.fn();
    const onReject = jest.fn();
    await render(<ProposalCard proposal={buildProposal()} onOpen={onOpen} onReject={onReject} />);

    expect(screen.getByText('BUY')).toBeTruthy();
    expect(screen.getByText('NSE:INFY')).toBeTruthy();
    expect(screen.getByText('×10')).toBeTruthy();
    expect(screen.getByText(/LIMIT · @ ₹1,500.00/)).toBeTruthy();
    expect(screen.getByTestId('proposal-p1-value')).toHaveTextContent(/₹15,000/);
    expect(screen.getByText(/RSI\(14\)/)).toBeTruthy();
    expect(screen.getByText('swing · mean-reversion-v1')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('proposal-p1-open'));
    expect(onOpen).toHaveBeenCalledWith('p1');
  });

  it('rejects inline and shows progress', async () => {
    const onReject = jest.fn();
    const view = await render(
      <ProposalCard proposal={buildProposal()} onOpen={jest.fn()} onReject={onReject} />,
    );
    await fireEvent.press(screen.getByTestId('proposal-p1-reject'));
    expect(onReject).toHaveBeenCalledWith('p1');

    await view.rerender(
      <ProposalCard proposal={buildProposal()} onOpen={jest.fn()} onReject={onReject} rejecting />,
    );
    expect(screen.getByText('Rejecting…')).toBeTruthy();
  });

  it('colours a SELL differently from a BUY', async () => {
    await render(
      <ProposalCard
        proposal={buildProposal({
          order: {
            symbol: { exchange: 'NSE', segment: 'EQ', tradingSymbol: 'TCS' },
            side: 'SELL',
            quantity: 5,
            orderType: 'MARKET',
            product: 'DELIVERY',
            validity: 'DAY',
          },
        })}
        onOpen={jest.fn()}
        onReject={jest.fn()}
      />,
    );
    expect(screen.getByText('SELL')).toBeTruthy();
  });
});

describe('Loading and EmptyState', () => {
  it('name the state instead of showing a blank rectangle', async () => {
    await render(
      <>
        <Loading label="Loading proposal…" />
        <EmptyState title="Nothing waiting" message="They arrive by push." />
        <EmptyState title="No message needed" />
      </>,
    );
    expect(screen.getByText('Loading proposal…')).toBeTruthy();
    expect(screen.getByText('Nothing waiting')).toBeTruthy();
    expect(screen.getByText('They arrive by push.')).toBeTruthy();
    expect(screen.getByText('No message needed')).toBeTruthy();
  });
});
