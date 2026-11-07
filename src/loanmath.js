// Loan balance calculation.
//
// Simple interest at `interest_rate` % per month, accrued daily on the
// outstanding principal (a month is counted as 30 days). Each payment is
// applied to accrued interest first, then to principal. Interest stops
// accruing on the loan's closed date.

const DAY_MS = 86400000;

function toDay(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Today's date (YYYY-MM-DD) in India, whatever time zone the server runs in.
const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
export function todayIso(now = new Date()) {
  return dateFmt.format(now);
}

export function computeLoan(loan, payments, asOf = todayIso()) {
  const end = loan.status === 'closed' && loan.closed_date ? loan.closed_date : asOf;
  const dailyRate = Number(loan.interest_rate) / 100 / 30;

  let principal = Number(loan.principal);
  let interestDue = 0;
  let interestAccrued = 0;
  let interestPaid = 0;
  let principalPaid = 0;
  let totalPaid = 0;
  let extraPaid = 0;
  let last = toDay(loan.start_date);

  const accrueTo = (day) => {
    if (day > last) {
      const i = principal * dailyRate * (day - last);
      interestDue += i;
      interestAccrued += i;
      last = day;
    }
  };

  const sorted = [...payments].sort((a, b) =>
    a.paid_on === b.paid_on ? a.id - b.id : a.paid_on < b.paid_on ? -1 : 1);

  for (const p of sorted) {
    accrueTo(Math.min(toDay(p.paid_on), toDay(end)));
    let amt = Number(p.amount);
    totalPaid += amt;
    const toInterest = Math.min(amt, interestDue);
    interestDue -= toInterest;
    interestPaid += toInterest;
    amt -= toInterest;
    const toPrincipal = Math.min(amt, principal);
    principal -= toPrincipal;
    principalPaid += toPrincipal;
    extraPaid += amt - toPrincipal;
  }
  accrueTo(toDay(end));

  const today = toDay(asOf);
  const overdue = loan.status === 'active' && !!loan.due_date && toDay(loan.due_date) < today;
  const daysRunning = Math.max(0, toDay(end) - toDay(loan.start_date));

  return {
    outstanding_principal: round2(principal),
    interest_due: round2(interestDue),
    total_due: round2(principal + interestDue),
    interest_accrued: round2(interestAccrued),
    interest_paid: round2(interestPaid),
    principal_paid: round2(principalPaid),
    total_paid: round2(totalPaid),
    extra_paid: round2(extraPaid),
    days_running: daysRunning,
    overdue,
  };
}
