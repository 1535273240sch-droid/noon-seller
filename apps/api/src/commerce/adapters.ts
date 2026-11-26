/** Local fixtures never carry real Noon credentials and produce no external side effects. */
export interface WarehouseSubmission {
  idempotencyKey: string;
  quantity: string;
  sku: string;
}
export type SubmissionResult = { type: 'accepted'; ref: string } | { type: 'timeout' | 'retryable' | 'fatal' };

export interface WarehouseAdapter {
  hasQuery: boolean;
  hasIdempotency: boolean;
  submit(order: WarehouseSubmission): Promise<SubmissionResult>;
  query(key: string): Promise<{ state: 'accepted'; ref: string } | { state: 'unknown' }>;
  cancel?(key: string): Promise<void>;
}

export function developmentWarehouse(outcome: string, attempt: number): WarehouseAdapter {
  const reference = (key: string) => 'DEMO-WH-' + key;
  return {
    hasIdempotency: true,
    hasQuery: outcome !== 'no_query',
    async submit({ idempotencyKey }) {
      if (outcome === 'timeout' || outcome === 'no_query') return { type: 'timeout' };
      if (outcome === 'retryable' && attempt === 1) return { type: 'retryable' };
      if (outcome === 'fatal') return { type: 'fatal' };
      return { type: 'accepted', ref: reference(idempotencyKey) };
    },
    async query(key) {
      return outcome === 'no_query' ? { state: 'unknown' } : { state: 'accepted', ref: reference(key) };
    },
  };
}

export function developmentOrder(orderNr: string) {
  return {
    fbpi_order_nr: orderNr,
    mp_order_nr: 'MP-' + orderNr,
    currency: 'AED',
    items: [1, 2, 3].map((index) => ({
      mp_item_nr: orderNr + '-' + index,
      partner_sku: 'DEMO-SKU-' + index,
    })),
  };
}
