/* Selftest chunk: Run-digest rollup builder (split from the monolith 10-29; run via selftest.mjs). */

/**
 * Run-digest rollup builder assertions; throws on first failure.
 */
export async function runDigest() {
    /* digest builder (extracted lib/digest): focal from game counters, lvlAct math,
       LOW_FOCAL precedence over CHIP_GAP, act-derived rerolls/celestial */
    {
        const { buildDigest } = await import('../lib/digest.mjs');
        const dig = buildDigest({
            obs: { run: { ante: 6 }, hands: [{ name: 'Pair', played: 9, level: 2 }, { name: 'Flush', played: 3, level: 4 }] },
            won: false,
            runStats: { lvl: 1, acts: ['planet:Mercury', 'take:Venus', 'reroll', 'pack:Celestial Pack'], jmax: 4, fams: {} },
            handsSnap: [],
            complete: true,
        });

        if (dig.focal !== 'Pair' || dig.focalPlays !== 9 || dig.lvlAct !== 3 || dig.rerolls !== 1 || !dig.celestial || dig.alert !== 'LOW_FOCAL_LEVEL' || dig.lvlMap !== 'Pair:2,Flush:4') {
            throw new Error(`digest builder drift ${JSON.stringify(dig)}`);
        }
    }
}
