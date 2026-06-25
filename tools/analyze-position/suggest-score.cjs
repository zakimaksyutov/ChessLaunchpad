#!/usr/bin/env node
// Interactive repertoire-suggestion move scorer.
//
//   node suggest-score.cjs [-skip] ["wG,wW,wE" ...]
//
// Prompts for a FEN, then loops. For each FEN it pulls the masters Top-5 +
// cloud-eval and scores each move on three normalized dimensions:
//   dGames  — share of Top-5 master games
//   dWin    — softmax over win margin (win% - loss%, user orientation; τ-scaled)
//   dEval   — share of eval-after, as an expected-score (logistic of cp)
//
// Each dimension is combined with per-dimension exponents (weights):
//   raw   = dGames^wG * dWin^wW * dEval^wE
//   p_sum = raw / Σraw      (linear / L1 normalization over the Top-5)
//
// `p_sum` always uses weights 1,1,1. Pass extra weight triples as args to add
// columns p_sum_1, p_sum_2, … (e.g. "0.3,2,2" "0.5,3,3"). Up to 10 columns
// total (including p_sum). Pass -skip to skip cloud-eval requests entirely
// (dEval becomes neutral). Enter a blank line or "q" to quit.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const REPO = path.resolve(__dirname, '../..');
const APP = path.join(REPO, 'app');
const { Chess } = require(path.join(APP, 'node_modules', 'chess.js'));

const MAX_COLUMNS = 10;

const args = process.argv.slice(2);
const SKIP_EVAL = args.includes('-skip');

// dWin temperature: dWin ∝ exp(margin / WIN_TAU), softmaxed over the Top-5.
// Lower = more contrast between margins. Override with -tau=<n>.
let WIN_TAU = 0.25;
const tauArg = args.find(a => a.startsWith('-tau='));
if (tauArg) {
    const v = parseFloat(tauArg.slice(5));
    if (v > 0) WIN_TAU = v;
    else console.error(`Ignoring bad -tau (must be > 0): "${tauArg}"`);
}

// Weight sets: p_sum (baseline 1,1,1) plus any "wG,wW,wE" args.
const weightSets = [[1, 1, 1]];
for (const arg of args) {
    if (arg === '-skip' || arg.startsWith('-tau=')) continue;
    const parts = arg.split(',').map(parseFloat);
    if (parts.length !== 3 || parts.some(Number.isNaN)) {
        console.error(`Ignoring bad weight triple: "${arg}" (expected wG,wW,wE)`);
        continue;
    }
    weightSets.push(parts);
    if (weightSets.length >= MAX_COLUMNS) break;
}
const colLabels = weightSets.map((_, i) => (i === 0 ? 'p_sum' : `p_sum_${i}`));

const tok = fs.readFileSync(path.join(REPO, '.env'), 'utf8')
    .split('\n').find(l => l.startsWith('LICHESS_TOKEN=')).split('=')[1].trim();

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Global rate limiter: at most one outgoing request per 2 seconds, shared
// across masters + cloud-eval. A 429 aborts the whole FEN (thrown to caller).
const MIN_REQUEST_GAP_MS = 2000;
let lastRequest = 0;
async function rlFetch(url, headers, label) {
    const wait = MIN_REQUEST_GAP_MS - (Date.now() - lastRequest);
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    console.log(`  → ${url}`);
    const r = await fetch(url, { headers: headers || {} });
    if (r.status === 429) throw new Error(`429 Too Many Requests on ${label} — aborting (rate-limited by Lichess)`);
    return r;
}

// cp (pawns, user orientation) -> expected score 0..1
const L = e => 1 / (1 + Math.pow(10, -e / 4));

// Cloud-eval cp for a FEN. Returns a number (cp) or null (404 / no data).
// A 429 propagates out of rlFetch and aborts the FEN. We send the Lichess
// token here too (the endpoint is public, but an authenticated request may get
// a higher rate limit than anonymous-by-IP).
async function cloudEvalCp(fen) {
    const r = await rlFetch(
        `https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}`,
        { Authorization: 'Bearer ' + tok }, 'cloud-eval');
    if (!r.ok) return null;                                       // 404 = no eval for this position
    const ce = await r.json();
    const pv = ce.pvs[0];
    return ('cp' in pv) ? pv.cp : (pv.mate > 0 ? 10000 : -10000);
}

async function scoreFen(FEN) {
    const userWhite = FEN.split(' ')[1] === 'w';
    const mr = await rlFetch(
        `https://explorer.lichess.org/masters?fen=${encodeURIComponent(FEN)}&moves=5`,
        { Authorization: 'Bearer ' + tok }, 'masters');
    const m = await mr.json();

    if (!m.moves || m.moves.length === 0) {
        console.log('No master games at this position.\n');
        return;
    }

    const rows = [];
    for (const mv of m.moves.slice(0, 5)) {
        const c = new Chess(FEN); c.move(mv.san);
        const games = mv.white + mv.draws + mv.black;
        const userWins = userWhite ? mv.white : mv.black;
        const oppWins = userWhite ? mv.black : mv.white;
        const margin = (userWins - oppWins) / games;            // win% - loss% (user orientation)
        const cp = SKIP_EVAL ? null : await cloudEvalCp(c.fen()); // 429 throws -> aborts this FEN
        rows.push({ san: mv.san, games, margin, eval: cp == null ? null : (userWhite ? cp : -cp) / 100 });
    }

    const sG = rows.reduce((a, r) => a + r.games, 0);
    // dWin: softmax over win margin (win% - loss%, user orientation). Strictly
    // positive for every move, so it never collapses even when the whole
    // position is below even (e.g. Black in most openings — all margins < 0).
    const mxM = Math.max(...rows.map(r => r.margin));
    const winExp = rows.map(r => Math.exp((r.margin - mxM) / WIN_TAU));
    const sW = winExp.reduce((a, b) => a + b, 0) || 1;
    // Missing cloud-eval -> assume a small -10cp disadvantage rather than 0, so
    // a sound popular move isn't deleted just because the eval was unavailable.
    rows.forEach(r => r.evES = L(r.eval == null ? -0.10 : r.eval));
    const sE = rows.reduce((a, r) => a + r.evES, 0);
    rows.forEach((r, i) => {
        r.dG = r.games / sG;
        r.dW = winExp[i] / sW;
        // -skip -> uniform (neutral) so eval contributes nothing to the ranking.
        r.dE = SKIP_EVAL ? 1 / rows.length : (sE > 0 ? r.evES / sE : 0);
    });

    // One p_sum column per weight set.
    rows.forEach(r => r.p = []);
    weightSets.forEach((w, k) => {
        const raws = rows.map(r => Math.pow(r.dG, w[0]) * Math.pow(r.dW, w[1]) * Math.pow(r.dE, w[2]));
        const sR = raws.reduce((a, b) => a + b, 0) || 1;
        rows.forEach((r, i) => r.p[k] = raws[i] / sR);
    });

    rows.sort((a, b) => b.p[0] - a.p[0]);   // sort by baseline p_sum

    const side = userWhite ? 'White' : 'Black';
    const wDesc = weightSets.map((w, i) => `${colLabels[i]}=[${w.join(',')}]`).join('  ');
    console.log(`\n(USER = ${side} to move)   τ=${WIN_TAU}   ${wDesc}`);
    let header = `move    games  margin(${side[0]}) eval(${side[0]}) |  dGames   dWin  dEval | `;
    header += colLabels.map(l => l.padStart(8)).join('');
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const r of rows) {
        let line =
            r.san.padEnd(6) + ' ' +
            String(r.games).padStart(7) + ' ' +
            ((r.margin >= 0 ? '+' : '') + (r.margin * 100).toFixed(1) + '%').padStart(8) + ' ' +
            (r.eval == null ? (SKIP_EVAL ? ' skip' : ' n/a*') : r.eval.toFixed(2)).padStart(7) + ' |  ' +
            r.dG.toFixed(3).padStart(6) + ' ' +
            r.dW.toFixed(3).padStart(6) + ' ' +
            r.dE.toFixed(3).padStart(6) + ' | ';
        line += r.p.map(p => ((p * 100).toFixed(1) + '%').padStart(8)).join('');
        console.log(line);
    }
    console.log('');
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let closed = false;
rl.on('close', () => { closed = true; });
const ask = () => new Promise(res => {
    if (closed) return res(null);
    rl.question('FEN> ', res);
});

(async () => {
    while (!closed) {
        const answer = await ask();
        if (answer == null) break;
        const line = answer.trim();
        if (!line || line.toLowerCase() === 'q') break;
        try {
            await scoreFen(line);
        } catch (e) {
            console.log('Error:', e.message, '\n');
        }
    }
    if (!closed) rl.close();
})();
