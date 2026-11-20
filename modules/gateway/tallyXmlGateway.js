const express = require('express');
const router = express.Router();
const xml2js = require('xml2js');
const { get, all } = require('../../core/db');
const { calculateBalanceSheet, calculateProfitLoss, calculateAllLedgerBalances, calculateClosingStockValuation } = require('../../core/accountingEngine');

// Handle Tally XML Protocol (Standard Tally 9000 Port Request)
router.post(['/', '/tally-xml'], async (req, res) => {
  try {
    let rawXml = '';
    if (typeof req.body === 'string') {
      rawXml = req.body;
    } else if (req.body && typeof req.body === 'object' && Object.keys(req.body).length === 1 && Object.keys(req.body)[0].startsWith('<ENVELOPE')) {
      rawXml = Object.keys(req.body)[0];
    } else {
      rawXml = req.rawBody || '';
    }

    // Default to Trial Balance if no specific request is parsed
    let reportName = 'Trial Balance';
    let requestType = 'Export Data';

    if (rawXml) {
      const parser = new xml2js.Parser({ explicitArray: false });
      try {
        const parsed = await parser.parseStringPromise(rawXml);
        if (parsed && parsed.ENVELOPE) {
          requestType = parsed.ENVELOPE.HEADER ? parsed.ENVELOPE.HEADER.TALLYREQUEST : 'Export Data';
          if (parsed.ENVELOPE.BODY && parsed.ENVELOPE.BODY.EXPORTDATA && parsed.ENVELOPE.BODY.EXPORTDATA.REQUESTDESC) {
            reportName = parsed.ENVELOPE.BODY.EXPORTDATA.REQUESTDESC.REPORTNAME || 'Trial Balance';
          }
        }
      } catch (e) {
        console.warn('XML parse fallback to default report:', e.message);
      }
    }

    const comp = await get('SELECT * FROM company_info LIMIT 1');
    const compName = comp ? comp.name : 'RRE Tally';
    const compGstin = comp ? comp.gstin : '33ANUPS7331M1Z8';

    let xmlResponse = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <STATUS>1</STATUS>
  </HEADER>
  <BODY>
    <DATA>
      <TALLYMESSAGE xmlns:UDF="TallyUDF">
        <COMPANY>
          <NAME>${compName}</NAME>
          <GSTIN>${compGstin}</GSTIN>
        </COMPANY>
`;

    if (reportName === 'Balance Sheet') {
      const bs = await calculateBalanceSheet();
      xmlResponse += `        <BALANCESHEET>
          <TOTALASSETS>${bs.assets.total}</TOTALASSETS>
          <TOTALLIABILITIES>${bs.liabilities.total}</TOTALLIABILITIES>
          <NETPROFIT>${bs.liabilities.net_profit}</NETPROFIT>
        </BALANCESHEET>
`;
    } else if (reportName.includes('Profit')) {
      const pl = await calculateProfitLoss();
      xmlResponse += `        <PROFITANDLOSS>
          <GROSSPROFIT>${pl.trading.gross_profit}</GROSSPROFIT>
          <NETPROFIT>${pl.indirect.net_profit}</NETPROFIT>
          <SALES>${pl.trading.sales}</SALES>
          <COGS>${pl.cogs}</COGS>
        </PROFITANDLOSS>
`;
    } else {
      // Trial Balance / All Accounts
      const ledgers = await calculateAllLedgerBalances();
      for (const l of ledgers) {
        xmlResponse += `        <LEDGER NAME="${l.name}">
          <PARENT>${l.group_name}</PARENT>
          <CLOSINGBALANCE>${l.closing_type === 'Cr' ? '-' : ''}${l.closing_balance}</CLOSINGBALANCE>
          <NETDEBIT>${l.net_debit}</NETDEBIT>
          <NETCREDIT>${l.net_credit}</NETCREDIT>
        </LEDGER>
`;
      }
    }

    xmlResponse += `      </TALLYMESSAGE>
    </DATA>
  </BODY>
</ENVELOPE>`;

    res.setHeader('Content-Type', 'text/xml');
    res.send(xmlResponse);
  } catch (err) {
    res.status(500).send(`<ENVELOPE><HEADER><STATUS>0</STATUS><ERROR>${err.message}</ERROR></HEADER></ENVELOPE>`);
  }
});

module.exports = router;
