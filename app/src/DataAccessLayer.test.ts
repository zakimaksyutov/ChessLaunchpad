import { DataAccessError, createDataAccessLayer } from "./DataAccessLayer";
import { OpeningVariantData } from "./RepertoireData";

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
        repertoireData.moveScores = {};
        // We can do some basic validation. For example, ensure the structure is correct.
        // The exact checks depend on your backend’s default initialization.
        expect(repertoireData).toBeDefined();

        // ----------------------------------------------------------------------------
        // 4. Attempt to store with a *fresh* DAL instance (which will NOT have the ETag)
        // ----------------------------------------------------------------------------
        const newVariants1: OpeningVariantData[] = [
            {
                pgn: "1. e4 e5",
                orientation: "white",
                classifications: [],
                errorEMA: 0,
                numberOfTimesPlayed: 0,
                lastSucceededEpoch: 0,
                successEMA: 0,
                moveScores: {}
            }
        ];

        repertoireData.data = newVariants1;
        repertoireData.currentEpoch = 1;
        repertoireData.lastPlayedDate = new Date();

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
        expect(Array.isArray(updatedData.data)).toBe(true);
        expect(updatedData.data.length).toBe(1);
        expect(updatedData.data[0].pgn).toBe("1. e4 e5");

        // ----------------------------------------------------------------------------
        // 8. Optionally, let's do a second update to show If-Match changes.
        // ----------------------------------------------------------------------------
        const newVariants2: OpeningVariantData[] = [
            {
                pgn: "1. d4 d5",
                orientation: "white",
                classifications: [],
                errorEMA: 0,
                numberOfTimesPlayed: 0,
                lastSucceededEpoch: 0,
                successEMA: 0,
                moveScores: {}
            }
        ];
        updatedData.data = newVariants2;
        await dal.storeRepertoireData(updatedData);

        // Now retrieve a final time
        const finalData = await dal.retrieveRepertoireData();
        expect(finalData.data.length).toBe(1);
        expect(finalData.data[0].pgn).toBe("1. d4 d5");

        // ----------------------------------------------------------------------------
        // 9. Delete the "UnitTest" user account with the random password
        // ----------------------------------------------------------------------------
        await dal.deleteAccount();
    }, 30000); // 30 seconds timeout
});
