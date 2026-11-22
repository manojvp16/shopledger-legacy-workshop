var test = require('node:test');
var assert = require('node:assert/strict');
var invoice = require('../lib/invoice');
var orders = require('../lib/orders');
var pricing = require('../lib/pricing');
var reports = require('../lib/reports');
var config = require('../config');

function recordOrder(db, items, coupon) {
  var totals = pricing.computeTotals(items, coupon);
  return orders.add(db, {
    date: '22/11/2026',
    items: items,
    coupon: coupon,
    subtotal: totals.subtotal,
    discount: totals.discount,
    tax: totals.tax,
    total: totals.total
  });
}

test('checkout caps SAVE10 and apportions it before calculating GST by HSN', function () {
  var totals = pricing.computeTotals([
    { hsn: '1006', price: 500, qty: 2 },
    { hsn: '0405', price: 1000, qty: 1 }
  ], 'SAVE10');

  assert.equal(totals.subtotal, 2000);
  assert.equal(totals.discount, 150);
  assert.equal(totals.taxable, 1850);
  assert.deepEqual(totals.lines.map(function (line) {
    return [line.gstPercent, line.discount, line.tax];
  }), [[5, 75, 46.25], [12, 75, 111]]);
  assert.equal(totals.tax, 157.25);
  assert.equal(totals.cgst, 78.63);
  assert.equal(totals.sgst, 78.62);
  assert.equal(totals.total, 2007.25);
});

test('invoice matches the billed total and GST for a capped coupon and mixed HSN rates', function () {
  var db = { orders: [], nextOrderId: 1001 };
  // Checkout stores HSN but omits gstRate from the order lines.
  var order = recordOrder(db, [
    { hsn: '1006', price: 500, qty: 2 },
    { hsn: '0405', price: 1000, qty: 1 }
  ], 'SAVE10');
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.total, 2007.25);
  assert.deepEqual(figures.rows.map(function (row) {
    return [row.hsn, row.gstPercent, row.lineTax];
  }), [['1006', 5, 46.25], ['0405', 12, 111]]);
  assert.equal(figures.subtotal, 2000);
  assert.equal(figures.discount, order.discount);
  assert.equal(figures.tax, order.tax);
  assert.equal(figures.cgst, 78.63);
  assert.equal(figures.sgst, 78.62);
  assert.equal(figures.total, order.total);

  var html = invoice.render(order);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">₹157\.25/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹2007\.25/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('invoice uses an explicit whole-percent GST rate and agrees on an undiscounted sale', function () {
  var db = { orders: [], nextOrderId: 1001 };
  var order = recordOrder(db, [{ price: 100, qty: 2, gstRate: 5 }], '');
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(figures.rows[0].gstPercent, 5);
  assert.equal(figures.tax, 10);
  assert.equal(figures.cgst, 5);
  assert.equal(figures.sgst, 5);
  assert.equal(figures.total, 210);
  assert.equal(figures.total, order.total);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('invoice honors zero and decimal GST rates like checkout', function () {
  var items = [
    { price: 100, qty: 1, gstRate: 0 },
    { price: 100, qty: 1, gstRate: 0.05 }
  ];
  var checkout = pricing.computeTotals(items, '');
  var figures = invoice.computeInvoiceFigures({ items: items });

  assert.deepEqual(checkout.lines.map(function (line) { return line.tax; }), [0, 5]);
  assert.deepEqual(figures.rows.map(function (row) { return row.lineTax; }), [0, 5]);
  assert.equal(figures.total, 205);
});

test('invoice GST includes the same rounded line taxes as checkout', function () {
  var items = [{ price: 0.03, qty: 1 }, { price: 0.03, qty: 1 }];
  var checkout = pricing.computeTotals(items, '');
  var figures = invoice.computeInvoiceFigures({ items: items });

  assert.equal(checkout.tax, 0.02);
  assert.deepEqual(figures.rows.map(function (row) { return row.lineTax; }), [0.01, 0.01]);
  assert.equal(figures.tax, 0.02);
  assert.equal(figures.cgst, 0.01);
  assert.equal(figures.sgst, 0.01);
});

test('reconciliation matches the invoice to a discounted order even when the total matched before the fix', function () {
  var db = { orders: [], nextOrderId: 1001 };
  var order = recordOrder(db, [{ price: 500, qty: 1 }], 'SAVE10');
  var report = reports.getGstReconciliation(db);
  var row = report.rows[0];

  assert.equal(report.totalChecked, 1);
  assert.equal(report.mismatchCount, 0);
  assert.equal(report.totalDelta, 0);
  assert.equal(row.ledgerTotal, 531);
  assert.equal(row.invoiceTotal, 531);
  assert.equal(row.ledgerTax, 81);
  assert.equal(row.invoiceTax, 81);
  assert.equal(row.matched, true);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('reprinting preserves the billed discount and GST after a coupon is disabled', function () {
  var db = { orders: [], nextOrderId: 1001 };
  var order = recordOrder(db, [{ price: 500, qty: 1 }], 'FLAT50');
  var coupon = config.coupons.FLAT50;
  var active = coupon.active;
  var figures;
  try {
    coupon.active = false;
    figures = invoice.computeInvoiceFigures(order);
  } finally {
    coupon.active = active;
  }

  assert.equal(figures.discount, 50);
  assert.equal(figures.rows[0].lineTax, 81);
  assert.equal(figures.tax, 81);
  assert.equal(figures.total, 531);
});
