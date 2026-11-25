'use client'

import { useShow } from '@refinedev/core'

import type { TransactionDto } from '@/api/generated/types.gen'
import { ShowView, ShowViewHeader } from '@/components/refine-ui/views/show-view'

export default function TransactionShow() {
  const { query } = useShow<TransactionDto>()
  const transaction = query.data?.data
  return (
    <ShowView>
      <ShowViewHeader title="Transaction" />
      {transaction ? (
        <dl className="grid gap-2">
          <dt>Counterparty</dt><dd>{transaction.counterparty}</dd>
          <dt>Amount</dt><dd>{transaction.amount} {transaction.currency}</dd>
          <dt>Status</dt><dd>{transaction.status}</dd>
        </dl>
      ) : <p>{query.isError ? 'Transaction could not be loaded.' : 'Loading transaction…'}</p>}
    </ShowView>
  )
}
