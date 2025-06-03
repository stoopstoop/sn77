import { computePoolWeights, fetchVotePositions, fetchBalances, calculatePoolWeights } from '../utils/poolWeights';

async function testPoolWeights() {
    console.log('🧪 Testing Pool Weights Calculation');
    console.log('=====================================\n');

    try {
        // Test the complete flow
        console.log('📊 Running complete pool weights calculation...\n');
        const [[normalized, raw], err] = await computePoolWeights();
        
        if (err) {
            console.error('❌ Error computing pool weights:', err.message);
            return;
        }

        console.log('✅ Pool weights calculated successfully!\n');
        
        // Display normalized weights
        console.log('📈 Normalized Pool Weights (sum = 1.0):');
        console.log('----------------------------------------');
        const normalizedEntries = Object.entries(normalized).sort((a, b) => b[1] - a[1]);
        
        if (normalizedEntries.length === 0) {
            console.log('No pools found with weights');
        } else {
            normalizedEntries.forEach(([pool, weight], index) => {
                console.log(`${index + 1}. ${pool}: ${(weight * 100).toFixed(2)}%`);
            });
            
            const totalNormalized = normalizedEntries.reduce((sum, [, weight]) => sum + weight, 0);
            console.log(`\nTotal: ${(totalNormalized * 100).toFixed(2)}%\n`);
        }
        
        // Display raw weights
        console.log('📊 Raw Pool Weights (before normalization):');
        console.log('-------------------------------------------');
        const rawEntries = Object.entries(raw).sort((a, b) => b[1] - a[1]);
        
        if (rawEntries.length === 0) {
            console.log('No pools found with raw weights');
        } else {
            rawEntries.forEach(([pool, weight], index) => {
                console.log(`${index + 1}. ${pool}: ${weight.toFixed(6)} Alpha`);
            });
            
            const totalRaw = rawEntries.reduce((sum, [, weight]) => sum + weight, 0);
            console.log(`\nTotal: ${totalRaw.toFixed(6)} Alpha\n`);
        }
        
        // Display summary stats
        console.log('📋 Summary Statistics:');
        console.log('----------------------');
        console.log(`Total pools: ${normalizedEntries.length}`);
        console.log(`Total weighted stake: ${Object.values(raw).reduce((sum, weight) => sum + weight, 0).toFixed(6)} Alpha`);
        
    } catch (error) {
        console.error('💥 Unexpected error:', error);
    }
}

async function testIndividualSteps() {
    console.log('\n🔍 Testing Individual Steps');
    console.log('============================\n');

    try {
        // Test vote positions fetching
        console.log('1. Fetching vote positions...');
        const [positions, posErr] = await fetchVotePositions();
        
        if (posErr) {
            console.error('❌ Error fetching positions:', posErr.message);
            return;
        }
        
        const voterCount = Object.keys(positions).length;
        const totalVotes = Object.values(positions).reduce((sum, votes) => sum + votes.length, 0);
        console.log(`✅ Found ${voterCount} voters with ${totalVotes} total votes\n`);
        
        // Display sample voters
        if (voterCount > 0) {
            console.log('📝 Sample voters:');
            Object.entries(positions).slice(0, 3).forEach(([voter, votes]) => {
                console.log(`  ${voter}: ${votes.length} vote(s)`);
                votes.slice(0, 2).forEach(vote => {
                    console.log(`    - ${vote.poolAddress}: ${vote.weight}`);
                });
            });
            console.log();
        }
        
        // Test balance fetching
        console.log('2. Fetching balances...');
        const [balances, balErr] = await fetchBalances(positions);
        
        if (balErr) {
            console.error('❌ Error fetching balances:', balErr.message);
            return;
        }
        
        const balanceCount = Object.keys(balances).length;
        const totalBalance = Object.values(balances).reduce((sum, bal) => sum + bal.balance, 0);
        console.log(`✅ Found balances for ${balanceCount} addresses, total: ${totalBalance.toFixed(6)} Alpha\n`);
        
        // Display sample balances
        if (balanceCount > 0) {
            console.log('💰 Sample balances:');
            Object.entries(balances).slice(0, 3).forEach(([addr, balance]) => {
                console.log(`  ${addr}: ${balance.balance.toFixed(6)} Alpha`);
            });
            console.log();
        }
        
        // Test weight calculation
        console.log('3. Calculating pool weights...');
        const [normalized, raw] = calculatePoolWeights(positions, balances);
        
        const poolCount = Object.keys(normalized).length;
        console.log(`✅ Calculated weights for ${poolCount} pools\n`);
        
    } catch (error) {
        console.error('💥 Unexpected error in individual steps:', error);
    }
}

async function main() {
    console.log('🚀 Starting Pool Weights Test Suite\n');
    
    await testPoolWeights();
    await testIndividualSteps();
    
    console.log('🎉 Test completed!');
}

if (require.main === module) {
    main().catch(console.error);
}

export { testPoolWeights, testIndividualSteps }; 