<script lang="ts">
  import { isAddress } from 'viem'
  import { errorMessage, formatAmount, formatDate, formatUsd } from './lib/format'
  import { loadPnl, type LoadResult } from './lib/load'

  const params = new URLSearchParams(location.search)
  let token = $state(params.get('token') ?? '')
  let wallet = $state(params.get('wallet') ?? '')
  let invalid = $state('')
  let loading = $state(false)
  let progress = $state<{ done: number; total: number } | null>(null)
  let error = $state('')
  let result = $state.raw<LoadResult | null>(null)
  // Ignores the answer of an older run if the user submitted again meanwhile.
  let runId = 0

  const sign = (n: number | null) => (n === null || n === 0 ? '' : n > 0 ? 'pos' : 'neg')
  const shortHash = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`

  async function submit(event?: SubmitEvent) {
    event?.preventDefault()
    token = token.trim()
    wallet = wallet.trim()
    invalid = !isAddress(token)
      ? 'Invalid token address: expected 0x followed by 40 hex characters (with a valid checksum if mixed-case).'
      : !isAddress(wallet)
        ? 'Invalid wallet address: expected 0x followed by 40 hex characters (with a valid checksum if mixed-case).'
        : ''
    if (invalid) {
      // Drop any run still in progress so its result can't land behind this message.
      runId++
      loading = false
      result = null
      error = ''
      return
    }

    history.replaceState(null, '', `?${new URLSearchParams({ token, wallet })}`)
    const id = ++runId
    loading = true
    progress = null
    error = ''
    result = null
    try {
      const r = await loadPnl(token, wallet, {
        onProgress: (done, total) => {
          if (id === runId) progress = { done, total }
        },
      })
      if (id === runId) result = r
    } catch (err) {
      if (id === runId) error = errorMessage(err)
    } finally {
      if (id === runId) loading = false
    }
  }

  if (params.get('token') && params.get('wallet')) submit()
</script>

<main>
  <h1>token-pnl</h1>
  <p class="lead">PnL of one wallet on one ERC-20 token (weighted average cost, USD).</p>

  <form onsubmit={submit}>
    <label>
      Token address
      <input bind:value={token} placeholder="0x…" spellcheck="false" autocomplete="off" required />
    </label>
    <label>
      Wallet address
      <input bind:value={wallet} placeholder="0x…" spellcheck="false" autocomplete="off" required />
    </label>
    <label>
      Chain
      <select><option>Ethereum</option></select>
    </label>
    <button disabled={loading}>{loading ? 'Loading…' : 'Compute PnL'}</button>
  </form>

  {#if invalid}
    <p class="msg error" role="alert">{invalid}</p>
  {:else if loading}
    <p class="msg" role="status">
      {#if progress && progress.total > 0}
        Pricing movements: {progress.done} / {progress.total} timestamps
        <progress value={progress.done} max={progress.total}></progress>
      {:else}
        Fetching transfers and balance…
      {/if}
    </p>
  {:else if error}
    <p class="msg error" role="alert">{error}</p>
  {:else if result && !result.pnl}
    <p class="msg">
      No transfers of {result.symbol ?? 'this token'} for this wallet on Ethereum. Check the addresses (token vs.
      wallet) and the chain.
    </p>
  {:else if result?.pnl}
    {@const { pnl, decimals, heldUsd, currentPrice, onchainBalance } = result}
    {@const t = pnl.totals}
    {@const unit = result.symbol ?? 'tokens'}

    {#if pnl.flags.unpricedCount > 0 || pnl.flags.oversell || pnl.flags.balanceMismatch || currentPrice === null}
      <ul class="warnings">
        {#if pnl.flags.unpricedCount > 0}
          <li>
            <strong>Incomplete result:</strong>
            {pnl.flags.unpricedCount} movement{pnl.flags.unpricedCount === 1 ? ' has' : 's have'} no historical price
            and count{pnl.flags.unpricedCount === 1 ? 's' : ''} as $0.
          </li>
        {/if}
        {#if pnl.flags.oversell}
          <li>
            <strong>Incomplete result:</strong> the wallet sent out more than it had received (rebasing or fee-on-transfer
            token?). The excess counts as sold at a cost of $0.
          </li>
        {/if}
        {#if pnl.flags.balanceMismatch}
          <li>
            <strong>Balance mismatch:</strong> computed holding {formatAmount(t.held, decimals)} {unit}, on-chain balance
            {formatAmount(onchainBalance, decimals)} {unit}. Likely a rebasing, reflection or fee-on-transfer token.
          </li>
        {/if}
        {#if currentPrice === null}
          <li><strong>No current price</strong> for this token: held value, unrealized and total PnL are unavailable.</li>
        {/if}
      </ul>
    {/if}

    <dl class="summary">
      <div class="total"><dt>Total PnL</dt><dd class={sign(t.total)}>{formatUsd(t.total)}</dd></div>
      <div><dt>Realized</dt><dd class={sign(t.realized)}>{formatUsd(t.realized)}</dd></div>
      <div><dt>Unrealized</dt><dd class={sign(t.unrealized)}>{formatUsd(t.unrealized)}</dd></div>
      <div><dt>Held</dt><dd>{formatAmount(t.held, decimals)} {unit}</dd></div>
      <div><dt>Held value</dt><dd>{formatUsd(heldUsd)}</dd></div>
      <div><dt>Current price</dt><dd>{formatUsd(currentPrice)}</dd></div>
      <div><dt>Cost basis</dt><dd>{formatUsd(t.cost)}</dd></div>
      <div><dt>Average cost</dt><dd>{formatUsd(t.averageCost)}</dd></div>
      <div><dt>Bought</dt><dd>{formatAmount(t.boughtQuantity, decimals)} {unit} · {formatUsd(t.boughtUsd)}</dd></div>
      <div><dt>Sold</dt><dd>{formatAmount(t.soldQuantity, decimals)} {unit} · {formatUsd(t.soldUsd)}</dd></div>
    </dl>

    <h2>Movements ({pnl.rows.length})</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Date</th><th>Dir.</th><th class="num">Amount</th><th class="num">Price</th><th class="num">USD value</th><th>Tx</th></tr>
        </thead>
        <tbody>
          {#each pnl.rows as row}
            <tr>
              <td>{formatDate(row.timestamp)}</td>
              <td class={row.direction === 'buy' ? 'pos' : 'neg'}>{row.direction}</td>
              <td class="num">{formatAmount(row.amount, decimals)}</td>
              <td class="num">{formatUsd(row.price)}</td>
              <td class="num">{formatUsd(row.usdValue)}</td>
              <td>
                <a href={`https://eth.blockscout.com/tx/${row.hash}`} target="_blank" rel="noopener noreferrer"
                  ><code>{shortHash(row.hash)}</code></a
                >
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</main>

<style>
  .lead {
    color: var(--muted);
    margin-top: -0.5rem;
  }
  form {
    display: grid;
    gap: 0.75rem;
  }
  label {
    display: grid;
    gap: 0.25rem;
    font-size: 0.9rem;
    font-weight: 600;
  }
  input,
  select,
  button {
    font: inherit;
    font-weight: normal;
    padding: 0.5rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    min-width: 0;
  }
  input {
    font-family: ui-monospace, monospace;
    font-size: 0.85rem;
  }
  button {
    justify-self: start;
    padding: 0.5rem 1.25rem;
    background: var(--accent);
    border-color: var(--accent);
    color: white;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.6;
    cursor: wait;
  }
  .msg {
    margin: 1.5rem 0;
    padding: 0.75rem 1rem;
    border-radius: 6px;
    background: var(--panel);
    overflow-wrap: anywhere;
  }
  .msg.error {
    background: var(--error-bg);
    color: var(--neg);
  }
  progress {
    display: block;
    width: 100%;
    margin-top: 0.5rem;
  }
  .warnings {
    margin: 1.5rem 0 0;
    padding: 0.75rem 1rem 0.75rem 2rem;
    border-radius: 6px;
    background: var(--warn-bg);
    overflow-wrap: anywhere;
  }
  .warnings li + li {
    margin-top: 0.4rem;
  }
  .summary {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    gap: 0.5rem 1.5rem;
    margin: 1.5rem 0;
  }
  .summary div {
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.4rem;
  }
  .summary .total {
    grid-column: 1 / -1;
  }
  .summary .total dd {
    font-size: 1.75rem;
    font-weight: 700;
  }
  dt {
    font-size: 0.8rem;
    color: var(--muted);
  }
  dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }
  .pos {
    color: var(--pos);
  }
  .neg {
    color: var(--neg);
  }
  .table-wrap {
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 0.85rem;
    white-space: nowrap;
  }
  th,
  td {
    padding: 0.4rem 0.6rem;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }
  th {
    background: var(--panel);
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  tbody tr:last-child td {
    border-bottom: none;
  }
</style>
