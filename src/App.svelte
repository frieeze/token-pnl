<script lang="ts">
  import { isAddress } from 'viem'
  import { errorMessage, formatAmount, formatDate, formatUsd } from './lib/format'
  import { loadPnl, type LoadResult, type LoadStep } from './lib/load'
  import { allowedClasses, applyOverrides, keysOf, parseOverridesParam, withOverride, withOverridesParam, type Overrides } from './lib/overrides'
  import { computePnl, type MovementClass } from './lib/pnl'
  import { parseWallets } from './lib/wallets'

  const params = new URLSearchParams(location.search)
  let token = $state(params.get('token') ?? '')
  // One `wallet` param per wallet, so an old single-wallet link still works.
  let wallets = $state(params.getAll('wallet').join('\n'))
  let invalid = $state('')
  let loading = $state(false)
  let progress = $state<{ done: number; total: number; step: LoadStep } | null>(null)
  let error = $state('')
  let result = $state.raw<LoadResult | null>(null)
  let overrides = $state<Overrides>(parseOverridesParam(params.get('overrides')))
  // Ignores the answer of an older run if the user submitted again meanwhile.
  let runId = 0

  const sign = (n: number | null) => (n === null || n === 0 ? '' : n > 0 ? 'pos' : 'neg')
  const shortHash = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`
  const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

  const movementKeys = $derived(keysOf(result?.movements ?? []))
  const classes = $derived(applyOverrides(result?.movements ?? [], overrides))

  // Recomputes the PnL locally from the already-loaded movements: no refetch.
  const pnl = $derived.by(() => {
    if (!result?.pnl) return result?.pnl ?? null
    return computePnl({
      decimals: result.decimals,
      movements: result.movements.map((m, i) => ({ ...m, class: classes[i]! })),
      currentPrice: result.currentPrice,
      onchainBalance: result.onchainBalance,
    })
  })

  function setOverrides(next: Overrides) {
    overrides = next
    history.replaceState(null, '', `?${withOverridesParam(location.search, next)}`)
  }

  function changeClass(i: number, cls: MovementClass) {
    setOverrides(withOverride(overrides, movementKeys[i]!, cls, result!.movements[i]!.class))
  }

  // `keepOverrides`: the initial load from a shared URL keeps its overrides; a fresh manual
  // search (new token/wallets) starts clean, since old overrides key movements that no longer apply.
  async function submit(event?: SubmitEvent, { keepOverrides = false } = {}) {
    event?.preventDefault()
    token = token.trim()
    const parsed = parseWallets(wallets)
    invalid = !isAddress(token)
      ? 'Invalid token address: expected 0x followed by 40 hex characters (with a valid checksum if mixed-case).'
      : 'error' in parsed
        ? parsed.error
        : ''
    if (invalid || 'error' in parsed) {
      // Drop any run still in progress so its result can't land behind this message.
      runId++
      loading = false
      result = null
      error = ''
      return
    }

    wallets = parsed.wallets.join('\n')
    if (!keepOverrides) overrides = new Map()
    const search = new URLSearchParams([['token', token], ...parsed.wallets.map((w) => ['wallet', w])])
    history.replaceState(null, '', `?${withOverridesParam(search, overrides)}`)
    const id = ++runId
    loading = true
    progress = null
    error = ''
    result = null
    try {
      const r = await loadPnl(token, parsed.wallets, {
        onProgress: (done, total, step) => {
          if (id === runId) progress = { done, total, step }
        },
      })
      if (id === runId) result = r
    } catch (err) {
      if (id === runId) error = errorMessage(err)
    } finally {
      if (id === runId) loading = false
    }
  }

  if (params.get('token') && params.getAll('wallet').some(Boolean)) submit(undefined, { keepOverrides: true })
</script>

<main>
  <h1>token-pnl</h1>
  <p class="lead">PnL of up to 5 wallets on one ERC-20 token, as one portfolio (weighted average cost, USD).</p>

  <form onsubmit={submit}>
    <label>
      Token address
      <input bind:value={token} placeholder="0x…" spellcheck="false" autocomplete="off" required />
    </label>
    <label>
      Wallet addresses (1 to 5, one per line)
      <textarea bind:value={wallets} rows="3" placeholder="0x…" spellcheck="false" autocomplete="off" required></textarea>
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
        {#if progress.step === 'classify'}
          Classifying movements: {progress.done} / {progress.total} transactions
        {:else}
          Pricing movements: {progress.done} / {progress.total} timestamps
        {/if}
        <progress value={progress.done} max={progress.total}></progress>
      {:else}
        Fetching transfers and balance…
      {/if}
    </p>
  {:else if error}
    <p class="msg error" role="alert">{error}</p>
  {:else if result && !result.pnl}
    <p class="msg">
      No transfers of {result.symbol ?? 'this token'} for these wallets on Ethereum. Check the addresses (token vs.
      wallet) and the chain.
    </p>
  {:else if result?.pnl && pnl}
    {@const { decimals, currentPrice, onchainBalance } = result}
    {@const t = pnl.totals}
    {@const unit = result.symbol ?? 'tokens'}
    {@const heldUsd = t.unrealized === null ? null : t.unrealized + t.cost}

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
            <strong>Incomplete result:</strong> the wallets sent out more than they had received (rebasing or fee-on-transfer
            token?). The excess counts as sold at a cost of $0.
          </li>
        {/if}
        {#if pnl.flags.balanceMismatch}
          <li>
            <strong>Balance mismatch:</strong> computed holding {formatAmount(t.held, decimals)} {unit}, on-chain balance
            (all wallets) {formatAmount(onchainBalance, decimals)} {unit}. Likely a rebasing, reflection or fee-on-transfer token.
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
      {#if t.deposited !== 0n}
        <div><dt>Deposited</dt><dd>{formatAmount(t.deposited, decimals)} {unit}</dd></div>
      {/if}
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
          <tr><th>Date</th><th>Wallet</th><th>Class</th><th class="num">Amount</th><th class="num">Price</th><th class="num">USD value</th><th>Tx</th></tr>
        </thead>
        <tbody>
          {#each pnl.rows as row, i}
            <tr>
              <td>{formatDate(row.timestamp)}</td>
              <td><code title={result.movements[i]!.wallet}>{shortAddress(result.movements[i]!.wallet)}</code></td>
              <td class={row.class === 'buy' ? 'pos' : row.class === 'sell' ? 'neg' : ''}>
                <select
                  value={row.class}
                  aria-label="Class"
                  onchange={(e) => changeClass(i, e.currentTarget.value as MovementClass)}
                >
                  {#each allowedClasses(row.class) as c}
                    <option value={c}>{c}</option>
                  {/each}
                </select>
                {#if classes[i] !== result.movements[i]!.class}
                  <span class="override-mark" title="Manually overridden">*</span>
                {/if}
              </td>
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
  textarea,
  select,
  button {
    font: inherit;
    font-weight: normal;
    padding: 0.5rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    min-width: 0;
  }
  input,
  textarea {
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
  select {
    font: inherit;
    padding: 0.15rem 0.3rem;
  }
  .override-mark {
    color: var(--accent);
    font-weight: 700;
  }
  tbody tr:last-child td {
    border-bottom: none;
  }
</style>
