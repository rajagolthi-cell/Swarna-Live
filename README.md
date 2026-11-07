# Swarna Live

A private web app for keeping loan records: customers, their contact and identity details, loans (including pledged gold), and payments.

## Features

- **Login protected.** The first person to open the site creates the admin account. You can add more staff accounts under Settings.
- **Customers.** Name, father/husband name, phone and alternate phone, email, date of birth, address, and two ID proofs (Aadhaar, PAN, Voter ID, Driving Licence, Passport, Ration Card…). ID numbers are hidden (`••••••••1234`) unless you click **Show**.
- **Loans.** Amount, interest rate (% per month), loan date, due date, and pledged items: type, gold weight in grams, purity and a description. Each loan gets a number like `SL-2026-0001`.
- **Payments.** Record each payment with its date, mode (Cash/UPI/Bank/Cheque) and a note. Balances update straight away.
- **Dashboard.** Total amount lent out, interest due, total receivable, gold held, money collected this month, overdue loans and recent payments.
- **Search** customers by name, phone or ID number, and loans by customer, phone or loan number. You can filter loans by active, overdue or closed.
- **Backup.** Settings → Download backup saves everything as a JSON file.
- Works on phones, has a dark mode, and loan pages can be printed.

### How interest is worked out

Simple interest at the monthly rate, counted daily on the principal still owed (a month is 30 days). A payment pays off interest due first, then principal. Interest stops when a loan is closed.

Example: ₹10,000 at 2% per month for 30 days earns ₹200 interest.

## Running it

You need [Node.js](https://nodejs.org) version 22.5 or newer.

```bash
npm install
npm start
```

Then open http://127.0.0.1:3000 and create your admin account.

Settings (environment variables):

| Variable        | Default            | Meaning                                                          |
|-----------------|--------------------|------------------------------------------------------------------|
| `PORT`          | `3000`             | Port to listen on                                                |
| `HOST`          | `127.0.0.1`        | Use `0.0.0.0` to let other devices on your network reach it      |
| `SWARNA_DB`     | `data/swarna.db`   | Where the database file is stored                                |
| `COOKIE_SECURE` | off                | Set to `1` when the site is served over HTTPS                    |

Run the tests with `npm test`.

## Keeping the data safe

This app stores personal and identity details, so:

- **Back up `data/swarna.db` regularly** (or use the Download backup button). If that file is lost, the records are gone.
- The `data/` folder is in `.gitignore`. **Never commit the database or a backup file to GitHub.**
- If you put it on the internet, serve it **only over HTTPS** (for example behind Caddy or Nginx) and set `COOKIE_SECURE=1`.
- Use strong passwords and give each staff member their own account.
- Check your local rules on storing ID numbers. In India, the Aadhaar rules limit storing full Aadhaar numbers, and many lenders keep only the last 4 digits or a masked copy.
