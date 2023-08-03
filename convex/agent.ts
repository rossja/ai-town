// 'use node';
// ^ This tells Convex to run this in a `node` environment.
// Read more: https://docs.convex.dev/functions/runtimes
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { Doc, Id } from './_generated/dataModel';

import { ActionCtx, internalAction } from './_generated/server';
import { MemoryDB } from './lib/memory';
import { Message } from './lib/openai';
import { Snapshot, Action, Position, Worlds } from './types';
import { converse, startConversation, walkAway } from './conversation';

export async function agentLoop(
  { player, nearbyPlayers, nearbyConversations, lastPlan }: Snapshot,
  memory: MemoryDB,
  actionAPI: ActionAPI,
  world: Doc<'worlds'>,
) {
  const imWalkingHere = player.motion.type === 'walking';
  const newFriends = nearbyPlayers.filter((a) => a.new).map(({ player }) => player);
  const othersThinking = newFriends.find((a) => a.thinking);
  const nearbyPlayerIds = nearbyPlayers.map(({ player }) => player.id);
  // Handle new observations
  //   Calculate scores
  //   If there's enough observation score, trigger reflection?
  // Wait for new memories before proceeding
  // Future: Store observations about seeing players?
  //  might include new observations -> add to memory with openai embeddings
  // Based on plan and observations, determine next action:
  //   if so, add new memory for new plan, and return new action

  // Check if any messages are from players still nearby.
  let relevantConversations = nearbyConversations.filter(
    (c) => c.messages.filter((m) => nearbyPlayerIds.includes(m.from)).length,
  );
  const lastConversation = relevantConversations.find(
    (c) => c.conversationId === player.lastSpokeConversationId,
  );
  if (lastConversation) {
    relevantConversations = [lastConversation];
  } else {
    if (player.lastSpokeConversationId) {
      // If we aren't part of a conversation anymore, remember it.
      await memory.rememberConversation(
        player.id,
        player.lastSpokeConversationId,
        player.lastSpokeTs,
      );
    }
  }

  for (const { conversationId, messages } of relevantConversations) {
    const chatHistory: Message[] = [
      ...messages.map((m) => ({
        role: 'user' as const,
        content: `${m.fromName} to ${m.toNames.join(',')}: ${m.content}\n`,
      })),
    ];
    const shouldWalkAway = await walkAway(chatHistory, player);
    console.log('shouldWalkAway: ', shouldWalkAway);

    // Decide if we keep talking.
    if (shouldWalkAway || messages.length >= 10) {
      // It's to chatty here, let's go somewhere else.
      if (!imWalkingHere) {
        if (await actionAPI({ type: 'travel', position: getRandomPosition(world) })) {
          return;
        }
      }
      break;
    } else if (messages.at(-1)?.from !== player.id) {
      // Let's stop and be social
      if (imWalkingHere) {
        await actionAPI({ type: 'stop' });
      }

      const playerCompletion = await converse(chatHistory, player, nearbyPlayers, memory);
      // display the chat via actionAPI
      await actionAPI({
        type: 'saySomething',
        audience: nearbyPlayers.map(({ player }) => player.id),
        content: playerCompletion,
        conversationId: conversationId,
      });
      // Now that we're remembering the conversation overall,
      // don't store every message. We'll have the messages history for that.
      // await memory.addMemories([
      //   {
      //     playerId: player.id,
      //     description: playerCompletion,
      //     ts: Date.now(),
      //     data: {
      //       type: 'conversation',
      //       conversationId: conversationId,
      //     },
      //   },
      // ]);

      // Only message in one conversation
      return;
    }
  }
  // We didn't say anything in a conversation yet.
  if (newFriends.length) {
    // Let's stop and be social
    if (imWalkingHere) {
      await actionAPI({ type: 'stop' });
    }
    // Hey, new friends
    if (!othersThinking) {
      // Decide whether we want to talk
      const newFriendsNames = newFriends.map((a) => a.name);
      const playerCompletion = await startConversation(newFriendsNames, memory, player);

      if (
        await actionAPI({
          type: 'startConversation',
          audience: newFriends.map((a) => a.id),
          content: playerCompletion,
        })
      ) {
        return;
      }
    }
  }
  if (!imWalkingHere) {
    // TODO: make a better plan
    const success = await actionAPI({ type: 'travel', position: getRandomPosition(world) });
    if (success) {
      return;
    }
  }
  // Otherwise I guess just keep walking?
  // TODO: consider reflecting on recent memories
}

export const runAgent = internalAction({
  args: { snapshot: Snapshot, noSchedule: v.optional(v.boolean()), world: Worlds.doc },
  handler: async (ctx, { snapshot, noSchedule, world }) => {
    const memory = MemoryDB(ctx);
    const actionAPI = ActionAPI(ctx, snapshot.player.id, noSchedule ?? false);
    try {
      await agentLoop(snapshot, memory, actionAPI, world);
    } finally {
      // should only be called from here, to match the "thinking" entry.
      await actionAPI({ type: 'done' });
    }
  },
});

export function ActionAPI(ctx: ActionCtx, playerId: Id<'players'>, noSchedule: boolean) {
  return (action: Action) => {
    return ctx.runMutation(internal.engine.handleAgentAction, {
      playerId,
      action,
      noSchedule,
    });
  };
}
export type ActionAPI = ReturnType<typeof ActionAPI>;

export function getRandomPosition(world: Doc<'worlds'>): Position {
  // TODO: read from world size
  return {
    x: Math.floor(Math.random() * world.width),
    y: Math.floor(Math.random() * world.height),
  };
}
