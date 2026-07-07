/**
 * CreateEnvelopePage.test.tsx — SS.4 / DD-98 / F1.10 + F1.11.
 *
 * The "Will you also sign this document?" checkbox was a DEAD toggle:
 * `isSenderSigner` was set but read nowhere, so checking it did NOT add the
 * creator to the submitted signers (the bug Barry caught in QA). These tests
 * lock the fix:
 *   - checking the box prepends the creator as a REAL signer row (email locked
 *     to their login email, name prefilled from their saved name, editable);
 *   - the box changes the SUBMITTED payload, not just UI state (regression
 *     guard for the dead-toggle bug);
 *   - unchecking removes that row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { apiPostMock, apiGetMock, navigateMock } = vi.hoisted(() => ({ apiPostMock: vi.fn(), apiGetMock: vi.fn(), navigateMock: vi.fn() }));

// useNavigate is mocked so the success path's navigate(...) is assertable — the
// `state: { justSent: true }` it passes drives the detail page's green "sent" banner.
vi.mock('react-router-dom', async (importActual) => {
  const actual = await importActual<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

// Logged-in creator with a saved name.
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { email: 'creator@example.com', display_name: 'Jordan R' },
    loading: false,
    refresh: vi.fn(),
    signOut: vi.fn(),
  }),
}));

// Mock only the network calls; keep the real formatUsd so the credit-gate's
// dollar strings render exactly as in production.
vi.mock('../lib/api', async (importActual) => {
  const actual = await importActual<typeof import('../lib/api')>();
  return { ...actual, apiPost: apiPostMock, apiGet: apiGetMock };
});

// Funded creator (form renders); broke creator (credit gate renders).
const SUFFICIENT_BALANCE = { balance_usd_micros: '1000000', envelope_cost_usd_micros: '250000', sufficient_for_envelope: true };
const INSUFFICIENT_BALANCE = { balance_usd_micros: '0', envelope_cost_usd_micros: '250000', sufficient_for_envelope: false };

import { CreateEnvelopePage } from './CreateEnvelopePage';

function renderPage() {
  return render(
    <MemoryRouter>
      <CreateEnvelopePage />
    </MemoryRouter>,
  );
}

function emailInputs() {
  return screen.getAllByPlaceholderText('jane.smith@example.com') as HTMLInputElement[];
}
function nameInputs() {
  return screen.getAllByPlaceholderText('e.g., Jane Smith') as HTMLInputElement[];
}
const PDF_FILE = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'doc.pdf', { type: 'application/pdf' });

describe('CreateEnvelopePage — "Will you also sign?" (SS.4 / F1.10 + F1.11)', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    apiPostMock.mockResolvedValue({ envelope_id: 'env_1' });
    apiGetMock.mockReset();
    apiGetMock.mockResolvedValue(SUFFICIENT_BALANCE);
  });

  it('checking the box adds a signer row whose email is the login email and is read-only', () => {
    renderPage();
    fireEvent.click(screen.getByRole('checkbox', { name: /also sign/i }));
    const creatorEmail = emailInputs().find((el) => el.value === 'creator@example.com');
    expect(creatorEmail).toBeTruthy();
    expect(creatorEmail!.readOnly).toBe(true);
  });

  it('prefills the creator row name from the saved display_name and keeps it editable', () => {
    renderPage();
    fireEvent.click(screen.getByRole('checkbox', { name: /also sign/i }));
    const creatorName = nameInputs().find((el) => el.value === 'Jordan R');
    expect(creatorName).toBeTruthy();
    expect(creatorName!.readOnly).toBe(false);
    fireEvent.change(creatorName!, { target: { value: 'Jordan Rivera' } });
    expect((nameInputs().find((el) => el.value === 'Jordan Rivera'))).toBeTruthy();
  });

  it('unchecking the box removes the creator row', () => {
    renderPage();
    const box = screen.getByRole('checkbox', { name: /also sign/i });
    fireEvent.click(box);
    expect(emailInputs().some((el) => el.value === 'creator@example.com')).toBe(true);
    fireEvent.click(box);
    expect(emailInputs().some((el) => el.value === 'creator@example.com')).toBe(false);
  });

  it('REGRESSION GUARD: checking the box puts the creator into the submitted signers[] payload', async () => {
    const { container } = renderPage();
    fireEvent.click(screen.getByRole('checkbox', { name: /also sign/i })); // adds creator row + leaves the initial empty row
    fireEvent.click(screen.getByText('Remove')); // drop the empty row → only the creator remains
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [PDF_FILE()] } });
    fireEvent.click(screen.getByRole('button', { name: /send for signing/i }));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalled());
    const payload = apiPostMock.mock.calls[0]![1] as { signers: Array<{ email: string; name: string }> };
    expect(payload.signers.some((s) => s.email === 'creator@example.com' && s.name === 'Jordan R')).toBe(true);
  });

  it('REGRESSION GUARD: leaving the box unchecked keeps the creator OUT of the payload', async () => {
    const { container } = renderPage();
    fireEvent.change(nameInputs()[0]!, { target: { value: 'Alice' } });
    fireEvent.change(emailInputs()[0]!, { target: { value: 'alice@example.com' } });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [PDF_FILE()] } });
    fireEvent.click(screen.getByRole('button', { name: /send for signing/i }));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalled());
    const payload = apiPostMock.mock.calls[0]![1] as { signers: Array<{ email: string; name: string }> };
    expect(payload.signers.some((s) => s.email === 'creator@example.com')).toBe(false);
    expect(payload.signers).toHaveLength(1);
  });
});

describe('CreateEnvelopePage — "signing on behalf of an organisation" (F-22.2 / AC-68)', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    apiPostMock.mockResolvedValue({ envelope_id: 'env_1' });
    apiGetMock.mockReset();
    apiGetMock.mockResolvedValue(SUFFICIENT_BALANCE);
  });

  const onBehalfBox = () => screen.getByRole('checkbox', { name: /on behalf of an organisation/i });

  it('hides the organisation input until the box is checked, then reveals it', () => {
    renderPage();
    expect(screen.queryByPlaceholderText('e.g., Acme Corp')).toBeNull();
    fireEvent.click(onBehalfBox());
    expect(screen.getByPlaceholderText('e.g., Acme Corp')).toBeInTheDocument();
  });

  it('submits on_behalf_of for a signer who declared one', async () => {
    const { container } = renderPage();
    fireEvent.change(nameInputs()[0]!, { target: { value: 'Alice' } });
    fireEvent.change(emailInputs()[0]!, { target: { value: 'alice@acme.com' } });
    fireEvent.click(onBehalfBox());
    fireEvent.change(screen.getByPlaceholderText('e.g., Acme Corp'), { target: { value: 'Acme Holdings LLC' } });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [PDF_FILE()] } });
    fireEvent.click(screen.getByRole('button', { name: /send for signing/i }));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalled());
    const payload = apiPostMock.mock.calls[0]![1] as { signers: Array<{ on_behalf_of?: string }> };
    expect(payload.signers[0].on_behalf_of).toBe('Acme Holdings LLC');
  });

  it('omits on_behalf_of for an individual signer (box unchecked)', async () => {
    const { container } = renderPage();
    fireEvent.change(nameInputs()[0]!, { target: { value: 'Bob' } });
    fireEvent.change(emailInputs()[0]!, { target: { value: 'bob@example.com' } });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [PDF_FILE()] } });
    fireEvent.click(screen.getByRole('button', { name: /send for signing/i }));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalled());
    const payload = apiPostMock.mock.calls[0]![1] as { signers: Array<{ on_behalf_of?: string }> };
    expect(payload.signers[0].on_behalf_of).toBeUndefined();
  });

  it('clears the organisation when the box is unchecked (no stale value submitted)', async () => {
    const { container } = renderPage();
    fireEvent.change(nameInputs()[0]!, { target: { value: 'Carol' } });
    fireEvent.change(emailInputs()[0]!, { target: { value: 'carol@example.com' } });
    fireEvent.click(onBehalfBox());
    fireEvent.change(screen.getByPlaceholderText('e.g., Acme Corp'), { target: { value: 'Typo Inc' } });
    fireEvent.click(onBehalfBox()); // uncheck → input hidden + cleared
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [PDF_FILE()] } });
    fireEvent.click(screen.getByRole('button', { name: /send for signing/i }));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalled());
    const payload = apiPostMock.mock.calls[0]![1] as { signers: Array<{ on_behalf_of?: string }> };
    expect(payload.signers[0].on_behalf_of).toBeUndefined();
  });
});

describe('CreateEnvelopePage — auto-close toggle (F-24.1)', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    apiPostMock.mockResolvedValue({ envelope_id: 'env_1' });
    apiGetMock.mockReset();
    apiGetMock.mockResolvedValue(SUFFICIENT_BALANCE);
  });

  const autoCloseBox = () => screen.getByRole('checkbox', { name: /send the signing record automatically/i });
  const fillAndSubmit = async (container: HTMLElement) => {
    fireEvent.change(nameInputs()[0]!, { target: { value: 'Alice' } });
    fireEvent.change(emailInputs()[0]!, { target: { value: 'alice@example.com' } });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [PDF_FILE()] } });
    fireEvent.click(screen.getByRole('button', { name: /send for signing/i }));
    await waitFor(() => expect(apiPostMock).toHaveBeenCalled());
  };

  it('defaults to auto_close=true in the submitted payload', async () => {
    const { container } = renderPage();
    expect((autoCloseBox() as HTMLInputElement).checked).toBe(true);
    await fillAndSubmit(container);
    expect((apiPostMock.mock.calls[0]![1] as { auto_close: boolean }).auto_close).toBe(true);
  });

  it('unchecking the toggle submits auto_close=false (manual seal)', async () => {
    const { container } = renderPage();
    fireEvent.click(autoCloseBox());
    await fillAndSubmit(container);
    expect((apiPostMock.mock.calls[0]![1] as { auto_close: boolean }).auto_close).toBe(false);
  });
});

describe('CreateEnvelopePage — QA fixes (Barry 2026-06-18)', () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    apiPostMock.mockResolvedValue({ envelope_id: 'env_1' });
    apiGetMock.mockReset();
    apiGetMock.mockResolvedValue(SUFFICIENT_BALANCE);
    navigateMock.mockReset();
    (window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = vi.fn();
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  });

  it('autofocuses the first signer Name field on open (Issue 1)', () => {
    renderPage();
    expect(nameInputs()[0]).toHaveFocus();
  });

  it('signer name/email suppress browser + password-manager autofill so the user identity is never injected (Issue 1/2, Barry QA)', () => {
    renderPage();
    const name = nameInputs()[0]!;
    const email = emailInputs()[0]!;
    // autoComplete=off alone is ignored by Chrome + password managers — assert the
    // PM ignore hints are also present on both fields.
    for (const el of [name, email]) {
      expect(el.getAttribute('autocomplete')).toBe('off');
      expect(el.getAttribute('data-lpignore')).toBe('true');
      expect(el.getAttribute('data-1p-ignore')).toBe('true');
    }
    // the email field must NOT be type="email" (the strongest autofill trigger);
    // inputMode="email" keeps the email keyboard on mobile.
    expect(email.getAttribute('type')).toBe('text');
    expect(email.getAttribute('inputmode')).toBe('email');
  });

  it('"will you sign" adds a DISTINCT creator row even when Signer 1 already has the creator email (Issue 2 — autofill-proof)', () => {
    renderPage();
    // Simulate the browser autofilling (or the user typing) their own email into Signer 1.
    fireEvent.change(emailInputs()[0]!, { target: { value: 'creator@example.com' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /also sign/i }));
    const matching = emailInputs().filter((el) => el.value === 'creator@example.com');
    expect(matching.length).toBe(2); // locked creator row + the typed one — NOT adopted
    expect(matching.some((el) => el.readOnly)).toBe(true);
    expect(matching.some((el) => !el.readOnly)).toBe(true);
  });

  it('unchecking removes ONLY the creator row — never wipes a typed signer that shares the email (Issue 2)', () => {
    renderPage();
    fireEvent.change(emailInputs()[0]!, { target: { value: 'creator@example.com' } });
    const box = screen.getByRole('checkbox', { name: /also sign/i });
    fireEvent.click(box); // add creator (2 rows)
    fireEvent.click(box); // remove creator
    const remaining = emailInputs();
    expect(remaining.length).toBe(1); // NOT zero
    expect(remaining[0]!.value).toBe('creator@example.com');
    expect(remaining[0]!.readOnly).toBe(false); // the surviving row is the typed one
  });

  it('submitting with a missing field jumps to the TOP of the page (not the field) + shows the error (Barry QA 2026-06-19)', async () => {
    const scrollSpy = vi.fn();
    window.scrollTo = scrollSpy as unknown as typeof window.scrollTo;
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /send for signing/i }));
    expect(await screen.findByText(/please upload a pdf/i)).toBeInTheDocument();
    // Always scroll to the top so the red error banner is seen — NEVER to one
    // offending field (there may be several; scrolling to one hides the rest).
    expect(scrollSpy).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
  });

  it('on a successful send, navigates to the new envelope carrying justSent state (Barry QA 2026-06-19)', async () => {
    const { container } = renderPage();
    fireEvent.change(nameInputs()[0]!, { target: { value: 'Alice' } });
    fireEvent.change(emailInputs()[0]!, { target: { value: 'alice@example.com' } });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [PDF_FILE()] } });
    fireEvent.click(screen.getByRole('button', { name: /send for signing/i }));
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith('/dashboard/envelope/env_1', { state: { justSent: true } }),
    );
  });

  it('picking a file always refreshes the Display name, even after editing it (Issue 4)', () => {
    const { container } = renderPage();
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const nameField = screen.getByPlaceholderText('e.g., NDA for Acme Corp') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [new File([new Uint8Array([0x25])], 'acme-approval.pdf', { type: 'application/pdf' })] } });
    expect(nameField.value).toBe('acme-approval');
    fireEvent.change(nameField, { target: { value: 'yO' } });
    expect(nameField.value).toBe('yO');
    fireEvent.change(fileInput, { target: { files: [new File([new Uint8Array([0x25])], 'final-contract.pdf', { type: 'application/pdf' })] } });
    expect(nameField.value).toBe('final-contract'); // refreshed, not stuck on "yO"
  });

  it('clears the file input value on click so re-picking the SAME file re-fires change (Issue 4b)', () => {
    // A real browser does NOT fire onChange when you re-select the identical file
    // (the input value is unchanged) — so the "always refresh the name" handler
    // never runs on a re-pick of the same file. The fix is to clear the input's
    // value on click, making the next selection always a change. jsdom can't
    // reproduce the no-fire behavior, so we assert the mechanism directly:
    // clicking the file input resets its value to ''.
    const { container } = renderPage();
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    let clearedToEmpty = false;
    Object.defineProperty(fileInput, 'value', {
      configurable: true,
      get: () => '',
      set: (v: string) => { if (v === '') clearedToEmpty = true; },
    });
    fireEvent.click(fileInput);
    expect(clearedToEmpty).toBe(true); // RED without the onClick reset
  });
});

describe('CreateEnvelopePage — up-front credit gate (F-13 / AC-5, Barry QA 2026-06-16)', () => {
  // GH#108 — the credit gate is a billing surface, so it runs only with billing ON.
  beforeEach(() => {
    apiPostMock.mockReset();
    apiGetMock.mockReset();
    vi.stubEnv('VITE_OPERATOR_CONFIG', JSON.stringify({ showBilling: true }));
  });
  afterEach(() => vi.unstubAllEnvs());

  it('insufficient balance replaces the form with an Add-credits referral — no form to fill', async () => {
    apiGetMock.mockResolvedValue(INSUFFICIENT_BALANCE);
    renderPage();

    // The referral appears once the balance resolves...
    expect(await screen.findByRole('button', { name: /add credits/i })).toBeInTheDocument();
    // ...and the form is GONE: no file picker, no signer fields, no Send button.
    expect(screen.queryByPlaceholderText('jane.smith@example.com')).toBeNull();
    expect(screen.queryByRole('button', { name: /send for signing/i })).toBeNull();
  });

  it('the referral shows the price in dollars, never raw micros ("what is that number?")', async () => {
    apiGetMock.mockResolvedValue(INSUFFICIENT_BALANCE);
    renderPage();
    await screen.findByRole('button', { name: /add credits/i });
    expect(screen.getByText(/\$0\.25/)).toBeInTheDocument(); // per-envelope cost, humanized
    expect(screen.queryByText(/250000/)).toBeNull();
  });

  it('Add credits starts Stripe checkout for the creator email', async () => {
    apiGetMock.mockResolvedValue(INSUFFICIENT_BALANCE);
    apiPostMock.mockResolvedValue({ url: 'https://checkout.stripe.test/s/1' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /add credits/i }));
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith('/v1/credits/checkout', { email: 'creator@example.com' }),
    );
  });

  it('sufficient balance renders the form (gate is closed only when broke)', async () => {
    apiGetMock.mockResolvedValue(SUFFICIENT_BALANCE);
    renderPage();
    expect((await screen.findAllByPlaceholderText('jane.smith@example.com')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /add credits/i })).toBeNull();
  });

  it('a failed balance read does NOT trap the user — form still renders (billing on, transient outage)', async () => {
    apiGetMock.mockRejectedValue(new Error('no billing configured'));
    renderPage();
    expect((await screen.findAllByPlaceholderText('jane.smith@example.com')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /add credits/i })).toBeNull();
  });

  it('a fork (billing off) renders the form and never reads /v1/credits (GH#108)', async () => {
    vi.stubEnv('VITE_OPERATOR_CONFIG', JSON.stringify({ showBilling: false }));
    apiGetMock.mockResolvedValue(INSUFFICIENT_BALANCE); // even a "broke" balance...
    renderPage();
    // ...never gates on a fork: the credit read is skipped, so the form renders.
    expect((await screen.findAllByPlaceholderText('jane.smith@example.com')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /add credits/i })).toBeNull();
    expect(apiGetMock.mock.calls.every(([u]) => !String(u).startsWith('/v1/credits'))).toBe(true);
  });
});
