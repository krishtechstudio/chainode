'use strict';
/*
  Entrypoint for the SDK
*/

// Requirements
const initKafka = require('../lib/kafka/initKafka');
const logger = require('../lib/logger');
const errors = require(`../lib/errors`);
const selectDb = require('../lib/database/select');
const backend = require('../web-console/backend/server');
const {
  isValidBlock,
  generateNextBlock
} = require('../lib/block');


// Blockchain sdk
module.exports = class {

  // Init SDK
  constructor(configs) {
    this.configs = configs;
    const { role, id, logs } = this.configs;
    this.logger = logger(role, id, logs.level, logs.path, logs.console);
  }

  // Check the role
  hasRole(r) {
    const { role } = this.configs;
    return role === r;
  }

  // Shutdown the peer broker and the web console
  async shutdown() {
    await this
      .stopWebConsole()
      .stop();
    return this;
  }

  // Start peer broker
  async start() {
    try {
      // Check params
      const {role, id, webui} = this.configs;
      this.logger.info(`Starting ${role} with id ${id}.`);

      // Get database model
      this.db = selectDb(this.configs.db, this.logger);
      
      // Get kafka consumer and producer
      const {consumer, producer} = await initKafka(this);
      this.consumer = consumer;
      this.producer = producer;

      // Init web console
      if (webui.enabled) {
        await this.startWebConsole();
      }
      this.logger.info(`The ${role} with id ${id} is ready.`);
      return this;
    } catch(err) {
      errors(this.logger, err);
    }
  }

  // Stop peer broker
  async stop() {
    return this.consumer.close(function(err, res) {
      return this;
    });
  }

  // Start the Web Console
  async startWebConsole() {
    const {webui} = this.configs;
    this.webapp = await backend(webui, this, this.logger, this.db);
    return this;
  }

  // Stop Web Console
  stopWebConsole() {
    this.webapp && this.webapp.close();
    return this;
  }

  // Produce message to a kafka topic
  async __produce(topic, data) {
    try {
      // Compose message
      const msg = {topic: topic, messages: data};
      // Produce message
      const self = this;
      return this.producer.send([msg], function(err, res) {
        if (err) throw Error(err);
        self.logger.debug('Produced to', res);
        return self;
      });
    } catch(err) {
      errors(this.logger, err);
    }
  }

  // Serialize data
  serialize(data) {
    return JSON.stringify(data);
  }

  // Deserialize data
  deserialize(data) {
    return JSON.parse(data);
  }

  // Select actions based on message and topic
  async onMessage(topic, data) {
    const { topics } = this.configs.kafka;
    const deserialized = this.deserialize(data);
    switch(topic) {
      case topics.pending:
        if (this.hasRole('peer')) {
          return await this.addBlockToLedger(deserialized);
        }
        return false;
      default:
        throw Error('Received message of an invalid topic');
    }
  }

  // Propose a new block
  async sendNewBlock(data) {
    try {
      // Item data
      const { organization } = this.configs;
      // Generate block
      const serializedData = this.serialize(data);
      const newblock = generateNextBlock(organization, serializedData);
      this.logger.info(`Building a block for the transaction ${newblock.hash} sended by organization ${organization}.`);
      this.logger.debug('Built new block', newblock);
      // Publish block
      const topic = this.configs.kafka.topics.pending;
      const serialized = this.serialize(newblock);
      await this.__produce(topic, serialized);
      // Return the new block
      return newblock.hash;
    } catch(err) {
      errors(this.logger, err);
    }
  }

  // Receive new blocks for adding to the ledger
  async addBlockToLedger(data) {
    try {
      // Get db model instance
      const db = this.db;
      // Check if block is valid
      const valid = isValidBlock(this.logger, data);
      if (!valid) {
        const invalidMsg = (data && data.hash) ? `Skipping invalid block ${data.hash}.` : 'Skipping an invalid block.';
        this.logger.error(invalidMsg);
        return false;
      }
      this.logger.debug(`Received block ${data.hash}.`);
      // Store block on db
      await db.Ledger.AddBlock(data);
      this.logger.info(`Added new block ${data.hash}.`);
      this.logger.debug('Added new block', data);
      // Return the new block
      return data.hash;
    } catch(err) {
      errors(this.logger, err);
    }
  }

}
