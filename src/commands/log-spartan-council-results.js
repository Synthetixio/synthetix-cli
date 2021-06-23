#!/usr/bin/env node
require('dotenv').config();

global.fetch = require('node-fetch');

const program = require('commander');
const ethers = require('ethers');
const { gray, red, green } = require('chalk');
const CouncilDilution = require('../abis/common/SpartanCouncilDilution.js');
const { setupProvider } = require('../utils/setupProvider');
const snapshot = require('@snapshot-labs/snapshot.js');
const axios = require('axios');

const spaceKey = 'spartancouncil.eth';

const PROPOSAL = ipfsHash => `https://hub.snapshot.page/api/spartancouncil.eth/proposal/${ipfsHash}`;

const SPACE = `https://hub.snapshot.page/api/spaces/spartancouncil.eth`;

async function ipfsGet(ipfsHash) {
	const url = `https://cloudflare-ipfs.com/ipfs/${ipfsHash}`;

	const { data } = await axios.get(url);

	const msgJSON = JSON.parse(data.msg);

	data.msg = msgJSON;

	return data;
}

async function logElection({ electionHash, providerUrl, network }) {
	if (!electionHash) throw new Error('Please specify the ipfs hash for the election');

	if (!providerUrl) {
		providerUrl = process.env.PROVIDER_URL.replace('network', network);
	}

	const archiveNode = new ethers.providers.InfuraProvider('mainnet', process.env.INFURA_ARCHIVE_KEY);

	const privateKey = process.env.PRIVATE_KEY;

	const { wallet, provider } = setupProvider({ providerUrl, privateKey });

	const contract = new ethers.Contract(CouncilDilution.address, CouncilDilution.abi, wallet || provider);

	const numOfCouncilMembersBN = await contract.numOfSeats();

	const numOfCouncilMembers = parseInt(numOfCouncilMembersBN.toString());

	let [proposal, votes, space] = await Promise.all([
		ipfsGet(electionHash),
		axios.get(PROPOSAL(electionHash)),
		axios.get(SPACE),
	]);

	const block = proposal.msg.payload.snapshot;

	const currentBlock = await provider.getBlockNumber();

	const blockTag = block > currentBlock ? 'latest' : parseInt(block);

	const scores = await Promise.resolve(
		snapshot.utils.getScores(
			spaceKey,
			space.data.strategies,
			space.data.network,
			archiveNode,
			Object.keys(votes.data),
			blockTag,
		),
	);

	votes = Object.fromEntries(
		Object.entries(votes.data)
			.map(vote => {
				vote[1].scores = space.data.strategies.map((_, i) => scores[i][vote[1].address] || 0);
				vote[1].balance = vote[1].scores.reduce((a, b) => a + b, 0);
				return vote;
			})
			.sort((a, b) => b[1].balance - a[1].balance)
			.filter(vote => vote[1].balance > 0),
	);

	const results = {
		totalScores: proposal.msg.payload.choices.map((_, i) =>
			space.data.strategies.map((_, sI) =>
				Object.values(votes)
					.filter(vote => vote.msg.payload.choice === i + 1)
					.reduce((a, b) => a + b.scores[sI], 0),
			),
		),
		choices: proposal.msg.payload.choices,
	};

	let mappedNomineesToScore = [];

	for (let i = 0; i < results.choices.length; i++) {
		const option = results.choices[i];

		const item = {
			member: option,
			choiceKey: i,
			score: results.totalScores[i][0],
		};

		mappedNomineesToScore.push(item);
	}

	let winners = mappedNomineesToScore.sort((a, b) => b.score - a.score).slice(0, numOfCouncilMembers);

	let winningChoiceKeys = winners.map(winner => {
		return winner.choiceKey;
	});

	let includedVoters = Object.values(votes)
		.filter(voter => {
			return winningChoiceKeys.includes(voter.msg.payload.choice - 1);
		})
		.map(element => {
			return {
				address: element.address,
				nomineesVotedFor: results.choices[element.msg.payload.choice - 1],
				assignedVoteWeight: element.balance,
			};
		});

	const arrayOfVoterAddress = includedVoters.map(i => i.address);

	let arrayOfNomineesVotedFor = [];

	includedVoters.map(i => {
		arrayOfNomineesVotedFor.push(i.nomineesVotedFor);
	});

	const arrayOfAssignedVoteWeights = includedVoters.map(i => i.assignedVoteWeight);

	const voters = arrayOfVoterAddress;
	const nomineesVotedFor = arrayOfNomineesVotedFor;
	const assignedVoteWeights = arrayOfAssignedVoteWeights;

	if (voters.length !== nomineesVotedFor.length && nomineesVotedFor.length !== assignedVoteWeights.length) {
		throw new Error('Invalid input array sizes');
	}

	let votersBatch = [];
	let nomineesVotedForBatch = [];
	let assignedVoteWeightsBatch = [];

	let i,
		j,
		chunk = 100;

	for (i = 0, j = voters.length; i < j; i += chunk) {
		votersBatch.push(voters.slice(i, i + chunk));
		nomineesVotedForBatch.push(nomineesVotedFor.slice(i, i + chunk));
		assignedVoteWeightsBatch.push(
			assignedVoteWeights.slice(i, i + chunk).map(weight => {
				return ethers.utils.parseEther(String(weight * 1e6));
			}),
		);
	}

	const nominatedCouncilMembers = winners.map(e => e.member);

	// console.log(nominatedCouncilMembers);
	// console.log(votersBatch);
	// console.log(nomineesVotedForBatch);
	// console.log(assignedVoteWeightsBatch);

	const latestNonce = await provider.getTransactionCount(wallet.address, 'latest');

	console.log(gray(`Using the latest transaction count as the nonce: ${latestNonce}`));

	let nextNonce = latestNonce;

	for (let i = 0; i < votersBatch.length; i++) {
		let transaction;
		try {
			transaction = await contract.logElection(
				electionHash,
				nominatedCouncilMembers,
				votersBatch[i],
				nomineesVotedForBatch[i],
				assignedVoteWeightsBatch[i],
				{ gasLimit: 8e6, nonce: nextNonce },
			);
		} catch (error) {
			console.log(red(`Error: sending transaction to log election at index ${i}`, error.toString()));
			throw error;
		}

		console.log(
			green(
				`Successfully logged election batch at index ${i} in transaction: https://etherscan.io/tx/${transaction.hash} (nonce: ${transaction.nonce})`,
			),
		);
		nextNonce++;
	}
}

program
	.description('Stores the results of a Spartan Council snapshot to the SpartanCouncilDilution contract')
	.option('--election-hash <value>', 'The ipfs hash of the snapshot proposal')
	.option('--provider-url <value>', 'The http provider to use for communicating with the blockchain')
	.option('-n, --network <value>', 'The network to run off', x => x.toLowerCase(), 'mainnet')
	.action(async (...args) => {
		try {
			await logElection(...args);
		} catch (err) {
			console.error(red(err));
			console.log(err.stack);

			process.exitCode = 1;
		}
	});

program.parse(process.argv);
