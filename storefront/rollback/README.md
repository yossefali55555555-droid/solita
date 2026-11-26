# Rollback copy of the old size-guide script

`solita-sizes.live-2026-11-26.js` is a byte-exact copy (sha256 8f4ac916…cfb5c) of the file that ran on the
Easy Orders store before the switch to `../solita-sizes.vercel.js`:
https://files.easy-orders.net/1794522852219857138solita-sizes.js

It reads sizes from a Google Sheet that is no longer public (it now redirects to sign-in), so it was
showing its built-in snapshot. To roll back, put the old URL back in the store's head code.
