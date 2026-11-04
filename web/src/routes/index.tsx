import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'

export const Route = createFileRoute('/')({
  component: BillSplitterApp,
})

// Data models
type Home = { id: string; name: string }
type Member = { id: string; homeId: string; name: string }
type Balance = { memberId: string; name: string; outstandingCents: number }
type Share = {
  id: string
  memberId: string
  memberName: string
  amountCents: number
  paidAt: string | null
}
type Bill = {
  id: string
  homeId: string
  title: string
  totalCents: number
  shares: Share[]
}

// Utility: format cents into dollars and cents
function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)} (${cents}¢)`
}

function BillSplitterApp() {
  // Application state
  const [homes, setHomes] = useState<Home[]>([])
  const [selectedHomeId, setSelectedHomeId] = useState<string>('')
  const [members, setMembers] = useState<Member[]>([])
  const [balances, setBalances] = useState<Balance[]>([])
  const [bills, setBills] = useState<Bill[]>([])

  // UI state: loading, error, and in-flight operations
  const [loading, setLoading] = useState<boolean>(true)
  const [apiError, setApiError] = useState<string | null>(null)
  const [payingShareId, setPayingShareId] = useState<string | null>(null)

  // Form inputs
  const [newHomeName, setNewHomeName] = useState<string>('')
  const [newMemberName, setNewMemberName] = useState<string>('')
  const [newBillTitle, setNewBillTitle] = useState<string>('')
  const [newBillTotalCents, setNewBillTotalCents] = useState<string>('')

  // 1. Fetch all homes
  const loadHomes = useCallback(async () => {
    try {
      const res = await fetch('/api/homes')
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.error || `Failed to fetch homes (status: ${res.status})`)
      }
      const data = (await res.json()) as { homes: Home[] }
      setHomes(data.homes)
      if (data.homes.length > 0 && !selectedHomeId) {
        const first = data.homes[0]
        if (first) {
          setSelectedHomeId(first.id)
        }
      }
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Error loading homes')
    }
  }, [selectedHomeId])

  // 2. Fetch data for the currently selected home
  const loadHomeDetails = useCallback(async (homeId: string) => {
    if (!homeId) return
    setLoading(true)
    setApiError(null)

    try {
      // Parallel fetch for members, balances, and bills
      const [membersRes, balancesRes, billsRes] = await Promise.all([
        fetch(`/api/homes/${homeId}/members`),
        fetch(`/api/homes/${homeId}/balances`),
        fetch(`/api/homes/${homeId}/bills`),
      ])

      if (!membersRes.ok || !balancesRes.ok || !billsRes.ok) {
        throw new Error('Failed to load home details from API')
      }

      const membersData = (await membersRes.json()) as { members: Member[] }
      const balancesData = (await balancesRes.json()) as { balances: Balance[] }
      const billsData = (await billsRes.json()) as { bills: Bill[] }

      setMembers(membersData.members)
      setBalances(balancesData.balances)
      setBills(billsData.bills)
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Failed to load home details')
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load
  useEffect(() => {
    loadHomes().finally(() => setLoading(false))
  }, [loadHomes])

  // Load home data whenever selected home changes
  useEffect(() => {
    if (selectedHomeId) {
      loadHomeDetails(selectedHomeId)
    } else {
      setMembers([])
      setBalances([])
      setBills([])
    }
  }, [selectedHomeId, loadHomeDetails])

  // Action: Create a new home
  async function handleCreateHome(e: React.FormEvent) {
    e.preventDefault()
    if (!newHomeName.trim()) return

    setApiError(null)
    try {
      const res = await fetch('/api/homes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newHomeName.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Failed to create home')

      setNewHomeName('')
      await loadHomes()
      setSelectedHomeId(data.id)
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Could not create home')
    }
  }

  // Action: Add a member to the current home
  async function handleAddMember(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedHomeId || !newMemberName.trim()) return

    setApiError(null)
    try {
      const res = await fetch(`/api/homes/${selectedHomeId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newMemberName.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Failed to add member')

      setNewMemberName('')
      await loadHomeDetails(selectedHomeId)
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Could not add member')
    }
  }

  // Action: Create and split a bill
  async function handleCreateBill(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedHomeId) return

    setApiError(null)
    const totalCentsNum = Number(newBillTotalCents)

    // Client-side guard for positive whole cents
    if (!Number.isInteger(totalCentsNum) || totalCentsNum <= 0) {
      setApiError('Total amount must be a positive whole integer of cents (e.g. 1000 for $10.00)')
      return
    }

    if (!newBillTitle.trim()) {
      setApiError('Bill title is required')
      return
    }

    try {
      const res = await fetch(`/api/homes/${selectedHomeId}/bills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: newBillTitle.trim(),
          totalCents: totalCentsNum,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Failed to create bill')

      setNewBillTitle('')
      setNewBillTotalCents('')
      await loadHomeDetails(selectedHomeId)
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Could not create bill')
    }
  }

  // Action: Pay a share with Idempotency-Key
  async function handlePayShare(billId: string, shareId: string) {
    setApiError(null)
    setPayingShareId(shareId)

    // Generate unique idempotency key for this payment attempt
    const idempotencyKey = crypto.randomUUID()

    try {
      const res = await fetch(`/api/bills/${billId}/shares/${shareId}/pay`, {
        method: 'POST',
        headers: {
          'Idempotency-Key': idempotencyKey,
        },
      })
      const data = await res.json()

      if (!res.ok) {
        // Keeps the share unpaid and surfaces the error
        throw new Error(data?.error || `Payment failed (status: ${res.status})`)
      }

      // Payment succeeded: reload home details to refresh shares and balances
      await loadHomeDetails(selectedHomeId)
    } catch (err) {
      // Keeps the share unpaid and shows an error message
      setApiError(err instanceof Error ? err.message : 'Payment failed')
    } finally {
      setPayingShareId(null)
    }
  }

  const selectedHome = homes.find((h) => h.id === selectedHomeId)

  return (
    <div style={styles.container}>
      {/* Header */}
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>Shared Bill Splitter</h1>
          <p style={styles.subtitle}>Fair, transparent shared home expense splitting</p>
        </div>
      </header>

      {/* Global Error Banner (handles 500s, offline, or invalid inputs) */}
      {apiError && (
        <div style={styles.errorBanner}>
          <span>⚠️ {apiError}</span>
          <button type="button" onClick={() => setApiError(null)} style={styles.dismissButton}>
            Dismiss
          </button>
        </div>
      )}

      {/* Home Selection / Creation Bar */}
      <section style={styles.card}>
        <h2 style={styles.sectionTitle}>Home</h2>
        <div style={styles.row}>
          {homes.length > 0 ? (
            <div style={styles.fieldGroup}>
              <label htmlFor="home-select" style={styles.label}>
                Select Home:
              </label>
              <select
                id="home-select"
                value={selectedHomeId}
                onChange={(e) => setSelectedHomeId(e.target.value)}
                style={styles.select}
              >
                {homes.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div style={styles.emptyNotice}>No homes created yet. Create one below to begin.</div>
          )}

          {/* Form to create a new home */}
          <form onSubmit={handleCreateHome} style={styles.inlineForm}>
            <input
              type="text"
              placeholder="New home name (e.g. Flat 4B)"
              value={newHomeName}
              onChange={(e) => setNewHomeName(e.target.value)}
              style={styles.input}
            />
            <button type="submit" style={styles.primaryButton}>
              Create Home
            </button>
          </form>
        </div>
      </section>

      {/* Main Home Details */}
      {selectedHome ? (
        <>
          {/* Members & Balances Grid */}
          <div style={styles.gridTwo}>
            {/* Members List */}
            <section style={styles.card}>
              <h2 style={styles.sectionTitle}>Members ({members.length})</h2>
              {members.length === 0 ? (
                <div style={styles.emptyNotice}>
                  No members yet. Add members to start splitting bills.
                </div>
              ) : (
                <ol style={styles.memberList}>
                  {members.map((member) => (
                    <li key={member.id} style={styles.memberItem}>
                      <span style={styles.memberName}>{member.name}</span>
                    </li>
                  ))}
                </ol>
              )}

              {/* Form to add a member */}
              <form onSubmit={handleAddMember} style={styles.addMemberForm}>
                <input
                  type="text"
                  placeholder="New member name"
                  value={newMemberName}
                  onChange={(e) => setNewMemberName(e.target.value)}
                  style={styles.input}
                />
                <button type="submit" style={styles.secondaryButton}>
                  Add Member
                </button>
              </form>
            </section>

            {/* Outstanding Balances */}
            <section style={styles.card}>
              <h2 style={styles.sectionTitle}>Outstanding Balances</h2>
              {balances.length === 0 ? (
                <div style={styles.emptyNotice}>No balance information available.</div>
              ) : (
                <div style={styles.balanceList}>
                  {balances.map((b) => (
                    <div key={b.memberId} style={styles.balanceRow}>
                      <span style={styles.balanceName}>{b.name}</span>
                      <span
                        style={{
                          ...styles.balanceAmount,
                          color: b.outstandingCents > 0 ? '#b91c1c' : '#15803d',
                        }}
                      >
                        {b.outstandingCents > 0
                          ? formatMoney(b.outstandingCents)
                          : 'Settled ($0.00)'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          {/* Create a Bill Section */}
          <section style={styles.card}>
            <h2 style={styles.sectionTitle}>Create New Bill</h2>
            {members.length === 0 ? (
              <div style={styles.warningNotice}>
                ⚠️ You must add at least one member to the home before creating a bill.
              </div>
            ) : (
              <form onSubmit={handleCreateBill} style={styles.billForm}>
                <div style={styles.formRow}>
                  <div style={styles.formGroup}>
                    <label htmlFor="bill-title" style={styles.label}>
                      Bill Title
                    </label>
                    <input
                      id="bill-title"
                      type="text"
                      placeholder="e.g. WiFi, Groceries, Electricity"
                      value={newBillTitle}
                      onChange={(e) => setNewBillTitle(e.target.value)}
                      style={styles.input}
                    />
                  </div>

                  <div style={styles.formGroup}>
                    <label htmlFor="bill-amount" style={styles.label}>
                      Total Amount (in whole cents)
                    </label>
                    <input
                      id="bill-amount"
                      type="number"
                      min="1"
                      step="1"
                      placeholder="e.g. 1000 for $10.00"
                      value={newBillTotalCents}
                      onChange={(e) => setNewBillTotalCents(e.target.value)}
                      style={styles.input}
                    />
                    {newBillTotalCents && Number(newBillTotalCents) > 0 && (
                      <span style={styles.helperText}>
                        Preview: ${(Number(newBillTotalCents) / 100).toFixed(2)}
                      </span>
                    )}
                  </div>

                  <button type="submit" style={{ ...styles.primaryButton, alignSelf: 'flex-end' }}>
                    Split &amp; Create Bill
                  </button>
                </div>
              </form>
            )}
          </section>

          {/* Bills and Shares Section */}
          <section style={styles.card}>
            <h2 style={styles.sectionTitle}>Bills &amp; Shares</h2>

            {loading ? (
              <div style={styles.loadingNotice}>Loading bills...</div>
            ) : bills.length === 0 ? (
              <div style={styles.emptyNotice}>
                No bills recorded yet for {selectedHome.name}. Create one above to split costs!
              </div>
            ) : (
              <div style={styles.billsList}>
                {bills.map((bill) => (
                  <div key={bill.id} style={styles.billCard}>
                    <div style={styles.billHeader}>
                      <div>
                        <h3 style={styles.billTitle}>{bill.title}</h3>
                        <span style={styles.billMeta}>
                          Total: <strong>{formatMoney(bill.totalCents)}</strong>
                        </span>
                      </div>
                    </div>

                    <div style={styles.sharesContainer}>
                      <h4 style={styles.sharesHeading}>Split Shares:</h4>
                      <div style={styles.sharesGrid}>
                        {bill.shares.map((share) => (
                          <div
                            key={share.id}
                            style={{
                              ...styles.shareItem,
                              borderColor: share.paidAt ? '#86efac' : '#fca5a5',
                              backgroundColor: share.paidAt ? '#f0fdf4' : '#fff1f2',
                            }}
                          >
                            <div>
                              <div style={styles.shareMemberName}>{share.memberName}</div>
                              <div style={styles.shareAmount}>{formatMoney(share.amountCents)}</div>
                            </div>

                            <div>
                              {share.paidAt ? (
                                <span style={styles.paidBadge}>✓ Paid</span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => handlePayShare(bill.id, share.id)}
                                  disabled={payingShareId === share.id}
                                  style={styles.payButton}
                                >
                                  {payingShareId === share.id ? 'Paying...' : 'Pay Share'}
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      ) : (
        <div style={styles.card}>
          <div style={styles.emptyNotice}>
            Please select or create a home to manage members, bills, and payments.
          </div>
        </div>
      )}
    </div>
  )
}

// Clean, responsive styling dictionary
const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 880,
    margin: '0 auto',
    padding: '32px 16px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: '#0f172a',
    backgroundColor: '#f8fafc',
    minHeight: '100vh',
  },
  header: {
    marginBottom: 24,
    borderBottom: '1px solid #e2e8f0',
    paddingBottom: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: 700,
    color: '#0f172a',
    margin: '0 0 6px 0',
  },
  subtitle: {
    fontSize: 14,
    color: '#64748b',
    margin: 0,
  },
  card: {
    backgroundColor: '#ffffff',
    border: '1px solid #e2e8f0',
    borderRadius: 8,
    padding: 20,
    marginBottom: 20,
    boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 600,
    color: '#1e293b',
    margin: '0 0 16px 0',
  },
  gridTwo: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
    gap: 20,
  },
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 16,
    alignItems: 'center',
  },
  fieldGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  label: {
    fontSize: 13,
    fontWeight: 500,
    color: '#475569',
  },
  select: {
    padding: '8px 12px',
    borderRadius: 6,
    border: '1px solid #cbd5e1',
    fontSize: 14,
    backgroundColor: '#fff',
    minWidth: 180,
  },
  input: {
    padding: '8px 12px',
    borderRadius: 6,
    border: '1px solid #cbd5e1',
    fontSize: 14,
    outline: 'none',
  },
  inlineForm: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
  },
  primaryButton: {
    backgroundColor: '#2563eb',
    color: '#ffffff',
    padding: '8px 16px',
    borderRadius: 6,
    border: 'none',
    fontWeight: 600,
    fontSize: 14,
    cursor: 'pointer',
  },
  secondaryButton: {
    backgroundColor: '#0f172a',
    color: '#ffffff',
    padding: '8px 14px',
    borderRadius: 6,
    border: 'none',
    fontWeight: 500,
    fontSize: 14,
    cursor: 'pointer',
  },
  errorBanner: {
    backgroundColor: '#fee2e2',
    color: '#991b1b',
    border: '1px solid #f87171',
    padding: '12px 16px',
    borderRadius: 6,
    marginBottom: 20,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontWeight: 500,
  },
  dismissButton: {
    backgroundColor: 'transparent',
    border: '1px solid #991b1b',
    color: '#991b1b',
    borderRadius: 4,
    padding: '4px 8px',
    cursor: 'pointer',
    fontSize: 12,
  },
  emptyNotice: {
    color: '#64748b',
    fontSize: 14,
    padding: '12px 0',
  },
  loadingNotice: {
    color: '#64748b',
    fontSize: 14,
    padding: 16,
    textAlign: 'center',
  },
  warningNotice: {
    backgroundColor: '#fef3c7',
    color: '#92400e',
    padding: 12,
    borderRadius: 6,
    fontSize: 14,
  },
  memberList: {
    margin: '0 0 16px 0',
    paddingLeft: 20,
    color: '#334155',
  },
  memberItem: {
    padding: '4px 0',
  },
  memberName: {
    fontWeight: 500,
  },
  addMemberForm: {
    display: 'flex',
    gap: 8,
  },
  balanceList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  balanceRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '8px 12px',
    backgroundColor: '#f1f5f9',
    borderRadius: 6,
  },
  balanceName: {
    fontWeight: 500,
  },
  balanceAmount: {
    fontWeight: 600,
  },
  billForm: {
    marginTop: 8,
  },
  formRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 16,
  },
  formGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    flex: 1,
    minWidth: 200,
  },
  helperText: {
    fontSize: 12,
    color: '#64748b',
  },
  billsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  billCard: {
    border: '1px solid #e2e8f0',
    borderRadius: 8,
    padding: 16,
    backgroundColor: '#ffffff',
  },
  billHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 12,
    borderBottom: '1px solid #f1f5f9',
    paddingBottom: 8,
  },
  billTitle: {
    fontSize: 16,
    fontWeight: 600,
    margin: '0 0 4px 0',
  },
  billMeta: {
    fontSize: 13,
    color: '#475569',
  },
  sharesContainer: {
    marginTop: 8,
  },
  sharesHeading: {
    fontSize: 13,
    fontWeight: 600,
    color: '#64748b',
    margin: '0 0 8px 0',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  sharesGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: 10,
  },
  shareItem: {
    border: '1px solid',
    borderRadius: 6,
    padding: '10px 12px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  shareMemberName: {
    fontSize: 14,
    fontWeight: 600,
    color: '#1e293b',
  },
  shareAmount: {
    fontSize: 13,
    color: '#475569',
    marginTop: 2,
  },
  paidBadge: {
    backgroundColor: '#16a34a',
    color: '#ffffff',
    fontSize: 12,
    fontWeight: 600,
    padding: '4px 8px',
    borderRadius: 4,
  },
  payButton: {
    backgroundColor: '#0284c7',
    color: '#ffffff',
    border: 'none',
    fontSize: 12,
    fontWeight: 600,
    padding: '6px 12px',
    borderRadius: 4,
    cursor: 'pointer',
  },
}
