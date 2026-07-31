import { useState } from 'react';
import { CustomerField } from './CustomerPicker.jsx';

export const CHEQUE_STATUSES = ['pending', 'deposited', 'cleared', 'bounced'];

export const STATUS_TONE = {
  pending: 'warn',
  deposited: 'info',
  cleared: 'ok',
  bounced: 'bad',
};

/** The transitions offered inline on a register row. */
export function nextStatuses(status) {
  if (status === 'pending') return ['deposited', 'bounced'];
  if (status === 'deposited') return ['cleared', 'bounced'];
  if (status === 'bounced') return ['pending'];
  return [];
}

const blank = (customer) => ({
  customer_id: customer?.id || '',
  customer_name: customer?.name || '',
  amount: '',
  cheque_number: '',
  bank_name: '',
  received_date: '',
  deposit_date: '',
  status: 'pending',
  note: '',
});

/**
 * Add / edit a cheque. Used by the Cheques register and by the cheques tab on a
 * customer, where `lockCustomer` pins it to that customer.
 */
export default function ChequeForm({
  cheque = null,
  customer = null,
  lockCustomer = false,
  onSubmit,
  onCancel,
  pending = false,
  submitLabel = 'Add cheque',
}) {
  const [form, setForm] = useState(
    cheque
      ? {
          customer_id: cheque.customer_id,
          customer_name: cheque.customer_name,
          amount: String(cheque.amount ?? ''),
          cheque_number: cheque.cheque_number || '',
          bank_name: cheque.bank_name || '',
          received_date: cheque.received_date || '',
          deposit_date: cheque.deposit_date || '',
          status: cheque.status,
          note: cheque.note || '',
        }
      : blank(customer)
  );

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const valid = form.customer_id && form.deposit_date && form.amount !== '' && Number(form.amount) >= 0;

  return (
    <form
      className="stack-form cheque-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        onSubmit({
          customer_id: form.customer_id,
          amount: Number(form.amount),
          cheque_number: form.cheque_number.trim() || null,
          bank_name: form.bank_name.trim() || null,
          received_date: form.received_date || null,
          deposit_date: form.deposit_date,
          status: form.status,
          note: form.note.trim() || null,
        });
      }}
    >
      <CustomerField
        value={form.customer_id}
        name={form.customer_name}
        locked={lockCustomer}
        onChange={(id, name) => set({ customer_id: id, customer_name: name })}
      />

      <div className="form-grid">
        <label>
          Amount (₹)
          <input
            type="number"
            min="0"
            step="0.01"
            required
            value={form.amount}
            onChange={(e) => set({ amount: e.target.value })}
          />
        </label>
        <label>
          Cheque no.
          <input type="text" value={form.cheque_number} onChange={(e) => set({ cheque_number: e.target.value })} />
        </label>
        <label>
          Bank
          <input type="text" value={form.bank_name} onChange={(e) => set({ bank_name: e.target.value })} />
        </label>
        <label>
          Received on
          <input type="date" value={form.received_date} onChange={(e) => set({ received_date: e.target.value })} />
        </label>
        <label>
          Deposit on
          <input
            type="date"
            required
            value={form.deposit_date}
            onChange={(e) => set({ deposit_date: e.target.value })}
          />
        </label>
        <label>
          Status
          <select value={form.status} onChange={(e) => set({ status: e.target.value })}>
            {CHEQUE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label>
        Note
        <input
          type="text"
          placeholder="Anything the rep should know before it is deposited"
          value={form.note}
          onChange={(e) => set({ note: e.target.value })}
        />
      </label>

      <div className="form-row">
        <button type="submit" className="btn" disabled={pending || !valid}>
          {pending ? 'Saving…' : submitLabel}
        </button>
        {onCancel ? (
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
