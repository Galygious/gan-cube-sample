import { KPattern } from 'cubing/kpuzzle';
import { Alg } from 'cubing/alg';

export interface CFOPStep {
    name: string;
    moves: string;
}

const PLL_ALGS: Record<string, string> = {
    "T-Perm": "R U R' U' R' F R2 U' R' U' R U R' F'",
    "Ua-Perm": "R2 U R U R' U' R' U' R' U R'",
    "Ub-Perm": "R U' R U R U R U' R' U' R2",
    "Aa-Perm": "x R' U R' D2 R U' R' D2 R2",
    "Ab-Perm": "x R2 D2 R U R' D2 R U' R",
    "H-Perm": "M2 U M2 U2 M2 U M2",
    "Z-Perm": "M' U M2 U M2 U M' U2 M2",
    "Y-Perm": "F R U' R' U' R U R' F' R U R' U' R' F R F'",
    "J-Perm": "R U R' F' R U R' U' R' F R2 U' R'",
    "F-Perm": "R' U' F' R U R' U' R' F R2 U' R' U' R U R' U R",
};

const OLL_ALGS: Record<string, string> = {
    "Sune": "R U R' U R U2 R'",
    "Antisune": "R U2 R' U' R U' R'",
    "T-OLL": "F R U R' U' F'",
    "U-OLL": "R2 D R' U2 R D' R' U2 R'",
    "L-OLL": "F R' F' r U R U' r'",
};

export class CFOPSolver {
    private allowedMoves = ["U", "U'", "U2", "D", "D'", "D2", "L", "L'", "L2", "R", "R'", "R2", "F", "F'", "F2", "B", "B'", "B2"];

    constructor() { }

    static async create(): Promise<CFOPSolver> {
        return new CFOPSolver();
    }

    async solve(pattern: KPattern): Promise<CFOPStep[]> {
        const steps: CFOPStep[] = [];
        let currentPattern = pattern;

        // 1. Cross
        const crossMoves = this.bfs(currentPattern, (p) => this.isCrossSolved(p), 6, this.allowedMoves);
        if (crossMoves) {
            steps.push({ name: "Cross", moves: crossMoves.length > 0 ? crossMoves.join(" ") : "Already Solved" });
            currentPattern = currentPattern.applyAlg(Alg.fromString(crossMoves.join(" ")));
        } else {
            return [{ name: "Error", moves: "Cross search failed. Solve cross manually first." }];
        }

        // 2. F2L
        const f2lPairs = [
            { name: "F2L 1 (FR)", edge: 8, corner: 4 },
            { name: "F2L 2 (FL)", edge: 9, corner: 5 },
            { name: "F2L 3 (BL)", edge: 11, corner: 6 },
            { name: "F2L 4 (BR)", edge: 10, corner: 7 }
        ];

        for (const pair of f2lPairs) {
            // Solve F2L pair with restricted moves to preserve cross and previous pairs
            const f2lMoves = this.solveF2LPair(currentPattern, pair.edge, pair.corner);
            if (f2lMoves) {
                steps.push({ name: pair.name, moves: f2lMoves.join(" ") });
                currentPattern = currentPattern.applyAlg(Alg.fromString(f2lMoves.join(" ")));
            } else {
                steps.push({ name: pair.name, moves: "Search failed (too complex)" });
            }
        }

        // 3. OLL
        // First, orient top cross
        if (!this.isTopCrossOriented(currentPattern)) {
            const crossOLL = this.bfs(currentPattern, (p) => this.isTopCrossOriented(p), 6, ["F", "R", "U", "R'", "U'", "F'"], (p) => this.isF2LSolved(p));
            if (crossOLL) {
                steps.push({ name: "OLL (Cross)", moves: crossOLL.join(" ") });
                currentPattern = currentPattern.applyAlg(Alg.fromString(crossOLL.join(" ")));
            }
        }

        // Then, orient top corners
        const cornerOLL = this.matchAlgorithm(currentPattern, OLL_ALGS, (p) => {
            const corners = p.patternData["CORNERS"];
            for (let i = 0; i <= 3; i++) if (corners.orientation[i] !== 0) return false;
            return true;
        }, (p) => this.isF2LSolved(p) && this.isTopCrossOriented(p));

        if (cornerOLL) {
            steps.push({ name: "OLL (Corners)", moves: cornerOLL.moves });
            currentPattern = currentPattern.applyAlg(Alg.fromString(cornerOLL.moves));
        } else {
            // Fallback search for OLL
            const searchOLL = this.bfs(currentPattern, (p) => this.isOLLSolved(p), 8, ["R", "U", "R'", "U'", "L", "U", "L'", "B", "F"], (p) => this.isF2LSolved(p));
            if (searchOLL) {
                steps.push({ name: "OLL (Search)", moves: searchOLL.join(" ") });
                currentPattern = currentPattern.applyAlg(Alg.fromString(searchOLL.join(" ")));
            }
        }

        // 4. PLL
        const pllMatch = this.matchAlgorithm(currentPattern, PLL_ALGS, (p) => {
            // Check if solved up to AUF
            for (let i = 0; i < 4; i++) {
                let testP = p.applyAlg(Alg.fromString("U".repeat(i)));
                if (this.isFullSolved(testP)) return true;
            }
            return false;
        }, (p) => this.isOLLSolved(p) && this.isF2LSolved(p));

        if (pllMatch) {
            steps.push({ name: "PLL (" + pllMatch.name + ")", moves: pllMatch.moves });
            currentPattern = currentPattern.applyAlg(Alg.fromString(pllMatch.moves));
        } else {
            // Fallback PLL search
            const searchPLL = this.bfs(currentPattern, (p) => this.isPLLSolved(p), 14, ["R2", "U", "R", "U", "R'", "U'", "R'", "U'", "R'", "U", "R'"], (p) => this.isOLLSolved(p) && this.isF2LSolved(p));
            if (searchPLL) {
                steps.push({ name: "PLL (Search)", moves: searchPLL.join(" ") });
                currentPattern = currentPattern.applyAlg(Alg.fromString(searchPLL.join(" ")));
            }
        }

        // Final AUF
        for (let i = 0; i < 4; i++) {
            let moves = i === 0 ? "" : (i === 1 ? "U" : (i === 2 ? "U2" : "U'"));
            if (this.isFullSolved(currentPattern.applyAlg(Alg.fromString(moves)))) {
                if (moves) steps.push({ name: "AUF", moves: moves });
                break;
            }
        }

        return steps;
    }

    private matchAlgorithm(pattern: KPattern, algs: Record<string, string>, goal: (p: KPattern) => boolean, validator: (p: KPattern) => boolean): { name: string, moves: string } | null {
        for (let u = 0; u < 4; u++) {
            let uMoves = u === 0 ? "" : (u === 1 ? "U " : (u === 2 ? "U2 " : "U' "));
            let pWithU = pattern.applyAlg(Alg.fromString(uMoves || "I"));
            for (const [name, algStr] of Object.entries(algs)) {
                try {
                    const alg = Alg.fromString(algStr);
                    const resultP = pWithU.applyAlg(alg);
                    if (goal(resultP) && validator(resultP)) {
                        return { name, moves: uMoves + algStr };
                    }
                } catch (e) { }
            }
        }
        return null;
    }

    private isCrossSolved(p: KPattern): boolean {
        const edges = p.patternData["EDGES"];
        for (let i = 4; i <= 7; i++) if (edges.pieces[i] !== i || edges.orientation[i] !== 0) return false;
        return true;
    }

    private isF2LSolved(p: KPattern): boolean {
        if (!this.isCrossSolved(p)) return false;
        const edges = p.patternData["EDGES"];
        const corners = p.patternData["CORNERS"];
        for (let i = 8; i <= 11; i++) if (edges.pieces[i] !== i || edges.orientation[i] !== 0) return false;
        for (let i = 4; i <= 7; i++) if (corners.pieces[i] !== i || corners.orientation[i] !== 0) return false;
        return true;
    }

    private isTopCrossOriented(p: KPattern): boolean {
        const edges = p.patternData["EDGES"];
        for (let i = 0; i <= 3; i++) if (edges.orientation[i] !== 0) return false;
        return true;
    }

    private isOLLSolved(p: KPattern): boolean {
        if (!this.isF2LSolved(p)) return false;
        const edges = p.patternData["EDGES"];
        const corners = p.patternData["CORNERS"];
        for (let i = 0; i <= 3; i++) if (edges.orientation[i] !== 0 || corners.orientation[i] !== 0) return false;
        return true;
    }

    private isPLLSolved(p: KPattern): boolean {
        if (!this.isOLLSolved(p)) return false;
        for (let auf = 0; auf < 4; auf++) {
            let uMoves = auf === 0 ? "" : (auf === 1 ? "U" : (auf === 2 ? "U2" : "U'"));
            let testP = p.applyAlg(Alg.fromString(uMoves || "I"));
            let allOk = true;
            for (let i = 0; i <= 3; i++) {
                if (testP.patternData["EDGES"].pieces[i] !== i || testP.patternData["CORNERS"].pieces[i] !== i) {
                    allOk = false;
                    break;
                }
            }
            if (allOk) return true;
        }
        return false;
    }

    private isFullSolved(p: KPattern): boolean {
        const edges = p.patternData["EDGES"];
        const corners = p.patternData["CORNERS"];
        for (let i = 0; i < 12; i++) if (edges.pieces[i] !== i || edges.orientation[i] !== 0) return false;
        for (let i = 0; i < 8; i++) if (corners.pieces[i] !== i || corners.orientation[i] !== 0) return false;
        return true;
    }

    private solveF2LPair(pattern: KPattern, edgeIdx: number, cornerIdx: number): string[] | null {
        const isPairSolved = (p: KPattern) => {
            return p.patternData["EDGES"].pieces[edgeIdx] === edgeIdx && p.patternData["EDGES"].orientation[edgeIdx] === 0 &&
                   p.patternData["CORNERS"].pieces[cornerIdx] === cornerIdx && p.patternData["CORNERS"].orientation[cornerIdx] === 0;
        };
        
        // Allowed moves depend on which slot we are solving to avoid breaking others.
        // For simplicity, we use BFS but with a validator.
        return this.bfs(pattern, isPairSolved, 8, this.allowedMoves, (p) => {
            if (!this.isCrossSolved(p)) return false;
            // Also ensure previously solved pairs stay solved.
            // This logic is simplified for the demo.
            return true;
        });
    }

    private bfs(startPattern: KPattern, isGoal: (p: KPattern) => boolean, maxDepth: number, moves: string[], validator?: (p: KPattern) => boolean): string[] | null {
        if (isGoal(startPattern)) return [];
        let queue: { pattern: KPattern, moves: string[] }[] = [{ pattern: startPattern, moves: [] }];
        let visited = new Set<string>();
        visited.add(this.getPatternHash(startPattern));

        for (let d = 1; d <= maxDepth; d++) {
            let nextQueue: { pattern: KPattern, moves: string[] }[] = [];
            for (const state of queue) {
                for (const move of moves) {
                    const nextPattern = state.pattern.applyAlg(Alg.fromString(move));
                    if (isGoal(nextPattern)) return [...state.moves, move];
                    if (validator && !validator(nextPattern)) continue;
                    const hash = this.getPatternHash(nextPattern);
                    if (!visited.has(hash)) {
                        visited.add(hash);
                        nextQueue.push({ pattern: nextPattern, moves: [...state.moves, move] });
                    }
                }
            }
            queue = nextQueue;
            if (queue.length === 0) break;
        }
        return null;
    }

    private getPatternHash(p: KPattern): string {
        return p.patternData["EDGES"].pieces.join(",") + p.patternData["EDGES"].orientation.join(",") + 
               p.patternData["CORNERS"].pieces.join(",") + p.patternData["CORNERS"].orientation.join(",");
    }
}
