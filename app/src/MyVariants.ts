import { OpeningVariant } from './OpeningVariant';

export class MyVariants {
    public static getVariants(): OpeningVariant[] {

        const variants: OpeningVariant[] = [
            new OpeningVariant(
                '1. e4 c6 2. d4 d5 3. e5 c5 4. Nf3 Bg4 5. c4 cxd4 6. cxd5 Qxd5 7. Nc3 Bxf3 8. Nxd5 Bxd1 9. Nc7+ Kd7 10. Nxa8 Bc2 11. Bd2 Nc6 12. Rc1 d3 13. h4',
                'white'
            ),
            new OpeningVariant(
                '1. e4 c6 2. d4 d5 3. e5 c5 4. Nf3 Nc6 5. c4 Bg4 6. cxd5 Qxd5 7. Nc3 Bxf3 8. Nxd5 Bxd1 9. Nc7+ Kd8 10. Nxa8',
                'white'
            ),
            new OpeningVariant(
                '1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5 4. Bc4 Nf6 5. d3 c6 6. Bd2 Qc7 7. Qe2 Bg4 8. f3 Bh5 9. g4 Bg6 10. f4',
                'white'
            ),
            new OpeningVariant(
                '1. e4 e5 2. Nf3 f5 3. Nxe5 Qf6 4. d4 d6 5. Nc4 fxe4 6. Nc3 Qg6 7. Ne3 Nf6 8. Be2 c6 9. O-O Be7 10. f3 exf3 11. Bd3',
                'white'
            ),
            new OpeningVariant(
                '1. e4 e6 2. d4 d5 3. Nc3 Nf6 4. Bg5 Be7 5. e5 Nfd7 6. h4 h6 7. Bxe7 Qxe7 8. f4 a6 9. Nf3 c5 10. Qd2 Nc6 11. Ne2 b5 12. g4 Nb6 13. b3',
                'white'
            ),
            new OpeningVariant(
                '1. e4 e6 2. d4 d5 3. e5 c5 4. c3 Nc6 5. Nf3 Bd7 6. a3 Nge7 7. b4 cxd4 8. cxd4 Nf5 9. Bb2 b5 10. Nc3 a5 11. Nxb5 axb4 12. a4',
                'black'
            ),
            new OpeningVariant(
                '1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 g6 6. Nxc6 bxc6 7. e5 Ng8 8. Bc4 Bg7 9. Qf3 e6 10. Bf4 Ne7 11. O-O-O',
                'white'
            ),
            new OpeningVariant(
                '1. Nc3 d5 2. e4 d4 3. Nce2 c5 4. Ng3 Nc6 5. Nf3 h5 6. h4 Bg4',
                'black'
            ),
            new OpeningVariant(
                '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Nxe4 6. d4 b5 7. Bb3 d5 8. dxe5 Be6 9. Qe2 Be7 10. Rd1 O-O 11. c4 bxc4 12. Bxc4 Bc5 13. Be3 Bxe3 14. Qxe3',
                'white'
            ),
            new OpeningVariant(
                '1. e4 e6 2. d4 d5 3. Nc3 Bb4 4. e5 c5 5. a3 Bxc3+ 6. bxc3 Ne7 7. Qg4 Qc7 8. Qxg7 Rg8 9. Qxh7 cxd4 10. Ne2 dxc3 11. f4 Nbc6 12. Qd3 d4 13. Nxd4 Nxd4 14. Qxd4 Bd7 15. Rg1 Nf5 16. Qf2 Qc6 17. Bd3 Qd5 18. Be3',
                'white'
            ),
            new OpeningVariant(
                '1. e4 e6 2. d4 d5 3. Nc3 Bb4 4. e5 c5 5. a3 Bxc3+ 6. bxc3 Ne7 7. Qg4 Qc7 8. Qxg7 Rg8 9. Qxh7 cxd4 10. Ne2 dxc3 11. f4 Nbc6 12. Qd3 d4 13. Nxd4 Nxd4 14. Qxd4 Bd7 15. Rg1 Nf5 16. Qf2 Qc6 17. Bd3 Qd5',
                'black'
            ),
            new OpeningVariant(
                '1. e4 g6 2. d4 Bg7 3. Nc3 d6 4. Be3 c6 5. Qd2 b5 6. Bd3',
                'white'
            ),
            new OpeningVariant(
                '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 g6 6. Be3 Bg7 7. f3 O-O 8. Qd2 Nc6 9. Bc4 Bd7 10. O-O-O Rc8 11. Bb3 Ne5 12. Kb1',
                'white'
            ),
            new OpeningVariant(
                '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 g6 6. Be3 Bg7 7. f3 O-O 8. Qd2 Nc6 9. Bc4 Bd7 10. O-O-O Rc8 11. Bb3 Nxd4 12. Bxd4 b5 13. Nd5 Nxd5 14. Bxg7 Kxg7 15. exd5 a5 16. a3',
                'white'
            ),
            new OpeningVariant(
                '1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. Nxd4 a6 5. Bd3 Nf6 6. O-O Qc7 7. Qe2 d6 8. c4 g6 9. Nc3 Bg7 10. Nf3 O-O 11. Bf4',
                'white'
            ),
            new OpeningVariant(
                '1. e4 e6 2. d4 d5 3. Nd2 c5 4. exd5 Qxd5 5. Ngf3 cxd4 6. Bc4 Qd7 7. O-O Nc6 8. Nb3 Nf6 9. Nbxd4 Nxd4 10. Nxd4 a6 11. Re1 Bc5 12. Be3 Qc7 13. Bb3 O-O',
                'black'
            ),
            new OpeningVariant(
                '1. e4 c6 2. d4 d5 3. e5 Bf5 4. Nf3 e6 5. Be2 Nd7 6. O-O Ne7 7. Nbd2 h6 8. Nb3 g5 9. a4 Bg7 10. a5 Qc7 11. Bd2 f6 12. exf6 Bxf6 13. Ne5 Nxe5 14. dxe5 Bxe5 15. Bh5+',
                'white'
            ),
            new OpeningVariant(
                '1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Nf3 c6 5. e3 Nbd7 6. Bd3 dxc4 7. Bxc4 b5 8. Bd3 Bb7 9. O-O a6 10. e4 c5',
                'black'
            ),
            new OpeningVariant(
                '1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. Nxd4 a6 5. Bd3 Bc5 6. Nb3 Be7 7. Qg4 g6 8. Qe2 d6 9. O-O Nd7 10. Nc3 Qc7 11. Bd2',
                'white'
            ),
            new OpeningVariant(
                '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 Nc6 6. Bg5 e6 7. Qd2 a6 8. O-O-O Bd7 9. f4 b5 10. Bxf6 gxf6 11. Kb1 Qb6 12. Nxc6 Bxc6 13. f5',
                'white'
            ),
            new OpeningVariant(
                '1. e4 e6 2. d4 d5 3. Bd3 dxe4 4. Bxe4 Nf6 5. Bf3 c5 6. Ne2 Nc6 7. Be3 cxd4 8. Nxd4 Ne5 9. Nc3 a6 10. Qe2 Nxf3+ 11. Qxf3 e5',
                'black'
            ),
            new OpeningVariant(
                '1. e4 e5 2. Nf3 d5 3. exd5 e4 4. Qe2 Nf6 5. Nc3 Be7 6. Nxe4 O-O 7. Nxf6+ Bxf6 8. d4 Qxd5 9. c3',
                'white'
            ),
            new OpeningVariant(
                '1. d4 d5 2. Nf3 Nf6 3. g3 Bf5 4. Bg2 e6 5. O-O Be7 6. c4 c6 7. Nc3 O-O 8. Nh4 dxc4',
                'black'
            ),
            new OpeningVariant(
                '1. d4 d5 2. Nf3 Nf6 3. Bg5 Ne4 4. Bf4 c5 5. e3 Qb6 6. Qc1 Nc6 7. c3 Bf5 8. Nbd2 e6',
                'black'
            ),
            new OpeningVariant(
                '1. e4 e6 2. d4 d5 3. Nc3 Nf6 4. Bg5 Bb4 5. e5 h6 6. Bd2 Bxc3 7. bxc3 Ne4 8. Qg4 g6 9. Bd3 Nxd2 10. Kxd2 c5 11. Nf3',
                'white'
            ),
            new OpeningVariant(
                '1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Nf3 c6 5. Bg5 h6 6. Bxf6 Qxf6 7. e3 g6 8. Bd3 Bg7 9. O-O O-O 10. e4 dxe4 11. Nxe4 Qd8',
                'black'
            ),
            new OpeningVariant(
                '1. d4 d5 2. c4 e6 3. Nf3 Nf6 4. g3 dxc4 5. Bg2 a6 6. Ne5 Bb4+ 7. Nc3 Nd5 8. Bd2 Nb6 9. e3 N8d7 10. Nxd7 Qxd7 11. Ne4 a5',
                'black'
            ),
            new OpeningVariant(
                '1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. Nf3 dxe5 5. Nxe5 c6 6. Be2 Bf5 7. O-O Nd7 8. Nf3 e6 9. c4 N5f6 10. Nc3 Bd6',
                'white'
            ),
            new OpeningVariant(
                '1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. Bg5 c6 5. Qd2 Nbd7 6. f4 d5 7. e5 Ne4 8. Nxe4 dxe4 9. Ne2 f6 10. Bh4 Bh6 11. g4',
                'white'
            ),
            new OpeningVariant(
                '1. Nf3 Nf6 2. g3 d5 3. Bg2 c6 4. O-O Bg4 5. d3 e6 6. Nbd2 Be7',
                'black'
            ),
            new OpeningVariant(
                '1. d4 d5 2. c4 e6 3. Nf3 Nf6 4. g3 dxc4 5. Bg2 a6 6. O-O Nc6 7. e3 Bd7 8. Qe2 Bd6',
                'black'
            ),
            new OpeningVariant(
                '1. d4 d5 2. Nf3 Nf6 3. e3 c5 4. c3 e6 5. Bd3 Nc6 6. Nbd2 Bd6 7. O-O O-O 8. Qe2 e5',
                'black'
            ),
            new OpeningVariant(
                '1. d4 d5 2. Bf4 Nf6 3. e3 c5 4. c3 Nc6 5. Nd2 Bf5 6. Ngf3 Qb6 7. Nh4 Bd7 8. Qb3 c4 9. Qc2 Nh5 10. Bg3 g6 11. Be2 Nxg3 12. hxg3 Bg7 13. e4 e6 14. Nhf3 O-O 15. O-O',
                'black'
            ),
            new OpeningVariant(
                '1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. Bg5 Bg7 5. f4 O-O 6. Qd2 c6 7. Bd3 b5 8. Nf3 Bg4 9. O-O Qb6 10. Ne2 Nbd7 11. Kh1',
                'white'
            ),
            new OpeningVariant(
                '1. d4 d5 2. e3 Nf6 3. Bd3 c5 4. c3 Nc6 5. Nd2 e5 6. dxe5 Nxe5',
                'black'
            ),
            new OpeningVariant(
                '1. e4 d6 2. d4 Nf6 3. Nc3 e5 4. Nf3 Nbd7 5. Bc4 Be7 6. O-O O-O 7. Re1 c6 8. a4 b6 9. Ba2',
                'white'
            ),
            new OpeningVariant(
                '1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 e6 5. Nc3 a6 6. Nxc6 bxc6 7. Bd3 d5 8. O-O Nf6 9. Re1 Be7 10. e5 Nd7 11. Qg4 g6 12. Bh6 Rb8 13. Nd1',
                'white'
            ),
            new OpeningVariant(
                '1. d4 d5 2. e3 Nf6 3. Bd3 c5 4. c3 Nc6 5. f4 Bg4 6. Nf3 e6 7. O-O Bd6',
                'black'
            ),
            new OpeningVariant(
                '1. e4 e6 2. c4 d5 3. exd5 exd5 4. cxd5 Nf6 5. Bb5+ Nbd7 6. Nc3 Be7 7. Nf3 O-O 8. O-O Nb6 9. d4 Nbxd5 10. Re1 c6',
                'black'
            ),
            new OpeningVariant(
                '1. e4 e6 2. d3 d5 3. Nd2 Nf6 4. Ngf3 c5 5. g3 Nc6 6. Bg2 Be7 7. O-O O-O 8. Re1 b5 9. e5 Nd7 10. Nf1 a5 11. h4 b4',
                'black'
            ),
            new OpeningVariant(
                '1. c4 Nf6 2. Nc3 g6 3. e4 d6 4. d4 Bg7 5. f4 O-O 6. Nf3 c5 7. d5 e6 8. dxe6 fxe6 9. Bd3 Nc6 10. O-O b6',
                'black'
            ),
            new OpeningVariant(
                '1. d4 d5 2. c4 e6 3. Nf3 Nf6 4. Nc3 c6 5. Bg5 h6 6. Bh4 dxc4 7. e4 g5 8. Bg3 b5 9. Be2 Bg7 10. e5 Nh5 11. a4 a6 12. Ne4 O-O',
                'black'
            ),
            new OpeningVariant(
                '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. Be3 e5 7. Nb3 Be6 8. f3 Be7 9. Qd2 h5 10. Nd5 Nxd5 11. exd5 Bf5 12. Na5 Nd7 13. Be2 Qc7 14. O-O O-O 15. c4 Nf6 16. b4',
                'white'
            ),
            new OpeningVariant(
                '1. e4 e6 2. d4 d5 3. Nc3 Nf6 4. Bg5 Be7 5. e5 Nfd7 6. h4 a6 7. Qg4 Bxg5 8. hxg5 c5 9. g6 f5 10. Qf4 h6 11. dxc5',
                'white'
            ),
            new OpeningVariant(
                '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O b5 6. Bb3 Bc5 7. a4 Rb8 8. c3 d6 9. d4 Bb6 10. a5 Ba7 11. h3 O-O 12. Be3',
                'white'
            ),
            new OpeningVariant(
                '1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 e6 5. Nc3 Nf6 6. Ndb5 d6 7. Bf4 e5 8. Bg5 a6 9. Na3 b5 10. Nd5',
                'white'
            ),
            new OpeningVariant(
                '1. e4 e6 2. f4 d5 3. e5 c5 4. Nf3 Nc6 5. c3 Nh6 6. Na3 Nf5 7. Nc2 Be7 8. d4 cxd4 9. cxd4 Qb6',
                'black'
            ),
            new OpeningVariant(
                '1. e4 e6 2. d4 d5 3. Nc3 Bb4 4. e5 c5 5. a3 Ba5 6. b4 cxd4 7. Nb5 Bc7 8. f4 Bd7 9. Nxc7+ Qxc7 10. Nf3 Ba4 11. Bd3',
                'white'
            ),
            new OpeningVariant(
                '1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 e6 5. Nc3 Qc7 6. Be3 a6 7. Qd2 Nf6 8. O-O-O Bb4 9. f3 d5 10. a3 Bxc3 11. Qxc3',
                'white'
            ),
            new OpeningVariant(
                '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 e5 6. Bb5+ Nbd7 7. Nf5 a6 8. Ba4 b5 9. Bb3 Nc5 10. Bg5',
                'white'
            ),
            new OpeningVariant(
                '1. e4 e6 2. d4 d5 3. e5 c5 4. c3 Nc6 5. Be3 Nh6 6. Bd3 Qb6 7. Qd2 Ng4',
                'black'
            ),
            new OpeningVariant(
                '1. e4 c6 2. d4 d5 3. e5 c5 4. Nf3 Nc6 5. c4 cxd4 6. Nxd4 e6 7. Nc3 Bb4 8. Nxc6 bxc6 9. Qa4',
                'black'
            ),
            new OpeningVariant(
                '1. e4 e6 2. d4 d5 3. Nd2 c5 4. exd5 Qxd5 5. Ngf3 cxd4 6. Bc4 Qd7 7. Nb3 Nc6 8. O-O Nf6 9. Qe2 a6 10. a4 Bd6 11. Rd1 e5 12. Nbxd4 Nxd4 13. Rxd4 Qe7',
                'black'
            ),
            new OpeningVariant(
                '1. d4 d5 2. Bg5 f6 3. Bh4 Nh6 4. f3 c5 5. dxc5 e6 6. Bf2 Qc7',
                'black'
            ),
            new OpeningVariant(
                '1. e4 e6 2. d4 d5 3. Nc3 Bb4 4. Ne2 dxe4 5. a3 Be7 6. Nxe4 Nf6 7. Nxf6+ Bxf6 8. Be3 Nc6 9. Qd2 b6',
                'black'
            ),
            new OpeningVariant(
                '1. e4 c6 2. d4 d5 3. e5 c5 4. Nf3 cxd4 5. Nxd4 Nc6 6. c4 e6 7. Nc3 Bb4 8. Nxc6 bxc6 9. Qa4',
                'white'
            ),
            new OpeningVariant(
                '1. e4 e6 2. d4 d5 3. Nc3 Bb4 4. e5 c5 5. a3 Bxc3+ 6. bxc3 Ne7 7. Nf3 b6 8. Bb5+ Bd7 9. Bd3 Ba4 10. O-O c4',
                'black'
            ),
            new OpeningVariant(
                '1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. Nxd4 Bc5 5. Nb3 Bb6 6. Nc3 Ne7 7. Bf4',
                'black'
            ),
            new OpeningVariant(
                '1. e4 e6 2. Nf3 d5 3. e5 c5 4. b4 b6 5. a3 Ne7 6. c3 a5',
                'black'
            ),
            new OpeningVariant(
                '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 O-O 8. a4 b4 9. d3 d6 10. a5',
                'white'
            )
        ];

        return variants;
    }
}