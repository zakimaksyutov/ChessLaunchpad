import { DataAccessError, createDataAccessLayer } from "./DataAccessLayer";
import { RepertoireEntry } from "../models/Repertoires";
import { Chess } from "chess.js";
import { normalizeFenResetHalfmoveClock } from "../utils/FenUtils";

describe.skip("DataAccessLayer - Main E2E Test", () => {
    const testUsername = "UnitTest";
    const cleanupPassword = "UnitTest"; // special password that allows cleanup
    let randomPassword: string;

    it("should create an account, store variants, retrieve them, and delete the account", async () => {
        // ----------------------------------------------------------------------------
        // 1. Cleanup from previous runs: Delete the "UnitTest" account using "UnitTest" password
        //    (this won't throw an error if the account doesn't exist; if it does, it deletes it)
        // ----------------------------------------------------------------------------
        const cleanupDAL = createDataAccessLayer(testUsername, cleanupPassword);
        try {
            await cleanupDAL.deleteAccount();
        } catch (error) {
            // Ignore errors; the account might not exist
        }

        // ----------------------------------------------------------------------------
        // 2. Create "UnitTest" user account with a *random* password (NOT "UnitTest")
        // ----------------------------------------------------------------------------
        randomPassword = "Pwd-" + Math.random().toString(36).slice(2, 10);
        const dal = createDataAccessLayer(testUsername, randomPassword);
        await dal.createAccount();

        // ----------------------------------------------------------------------------
        // 3. Retrieve variants (should be empty or default)
        // ----------------------------------------------------------------------------
        let repertoireData = await dal.retrieveRepertoireData();
        // We can do some basic validation. For example, ensure the structure is correct.
        // The exact checks depend on your backend’s default initialization.
        expect(repertoireData).toBeDefined();

        // ----------------------------------------------------------------------------
        // 4. Attempt to store with a *fresh* DAL instance (which will NOT have the ETag)
        // ----------------------------------------------------------------------------
        const root = normalizeFenResetHalfmoveClock(new Chess().fen());
        const afterE4 = (() => { const c = new Chess(); c.move('e4'); return normalizeFenResetHalfmoveClock(c.fen()); })();
        const afterE4E5 = (() => { const c = new Chess(); c.move('e4'); c.move('e5'); return normalizeFenResetHalfmoveClock(c.fen()); })();

        const whiteReps1: RepertoireEntry[] = [
            {
                name: 'White', orientation: 'white',
                positions: {
                    [root]: { moves: { e4: {} } },
                    [afterE4]: { moves: { e5: {} } },
                    [afterE4E5]: { moves: {} },
                },
            },
            { name: 'Black', orientation: 'black', positions: {} },
        ];

        repertoireData.repertoires = whiteReps1;

        // Store with the fresh DAL -> Expect a "Precondition Failed." error (from server)
        let missingIfMatchError: DataAccessError | undefined;
        const newDalNoEtag = createDataAccessLayer(testUsername, randomPassword);
        try {
            await newDalNoEtag.storeRepertoireData(repertoireData);
        } catch (err) {
            expect(err).toBeInstanceOf(DataAccessError);
            missingIfMatchError = err as DataAccessError;
        }
        expect(missingIfMatchError).toBeDefined();
        expect(missingIfMatchError!.statusCode).toBe(412); // Precondition Failed

        // ----------------------------------------------------------------------------
        // 5. Now store with the original DAL (which has the ETag), expect success
        // ----------------------------------------------------------------------------
        await dal.storeRepertoireData(repertoireData);

        // ----------------------------------------------------------------------------
        // 6. Now store again - we're testing that we can successfully store without retrieving in between
        // ----------------------------------------------------------------------------
        await dal.storeRepertoireData(repertoireData);

        // ----------------------------------------------------------------------------
        // 7. Retrieve variants again, ensure they contain what we just added
        // ----------------------------------------------------------------------------
        const updatedData = await dal.retrieveRepertoireData();
        const updatedWhite = updatedData.repertoires?.find(r => r.orientation === 'white');
        expect(updatedWhite).toBeDefined();
        expect(updatedWhite!.positions[root]?.moves['e4']).toBeDefined();

        // ----------------------------------------------------------------------------
        // 8. Optionally, let's do a second update to show If-Match changes.
        // ----------------------------------------------------------------------------
        const afterD4 = (() => { const c = new Chess(); c.move('d4'); return normalizeFenResetHalfmoveClock(c.fen()); })();
        const afterD4D5 = (() => { const c = new Chess(); c.move('d4'); c.move('d5'); return normalizeFenResetHalfmoveClock(c.fen()); })();
        const whiteReps2: RepertoireEntry[] = [
            {
                name: 'White', orientation: 'white',
                positions: {
                    [root]: { moves: { d4: {} } },
                    [afterD4]: { moves: { d5: {} } },
                    [afterD4D5]: { moves: {} },
                },
            },
            { name: 'Black', orientation: 'black', positions: {} },
        ];
        updatedData.repertoires = whiteReps2;
        await dal.storeRepertoireData(updatedData);

        // Now retrieve a final time
        const finalData = await dal.retrieveRepertoireData();
        const finalWhite = finalData.repertoires?.find(r => r.orientation === 'white');
        expect(finalWhite!.positions[root]?.moves['d4']).toBeDefined();
        expect(finalWhite!.positions[root]?.moves['e4']).toBeUndefined();

        // ----------------------------------------------------------------------------
        // 9. Delete the "UnitTest" user account with the random password
        // ----------------------------------------------------------------------------
        await dal.deleteAccount();
    }, 30000); // 30 seconds timeout
});
