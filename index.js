//https://expressjs.com/
var express = require('express');
var app = express();

//https://faye.jcoglan.com/
var faye = require('faye');

//https://rethinkdb.com/
var r = require('rethinkdb');

//https://lodash.com/docs
var _ = require('lodash');

//https://github.com/expressjs/body-parser
var bodyParser = require('body-parser');

// We need a  server to attach Faye to
var server = require('http').Server(app);

// Setup Faye on the route /faye
bayeux = new faye.NodeAdapter({mount: '/faye', timeout: 45});
bayeux.attach(server);

// Serve static files out of ./public
app.use(express.static('public'));

// Parse requests
app.use(bodyParser.urlencoded({ extended: false }))

// Names for our database and table
const databaseName = "yeti";
const tableName = "sightings";

// Sets up the database (Promise)
function ensureDatabaseExists(conn) {
    return new Promise(function(resolve, reject){
        console.log("Checking if database "+databaseName+" exists");
        r.dbList().contains(databaseName).run(conn)
        .then(function(databaseExists){
            if(databaseExists) {
                console.log("Database "+databaseName+" exists");
                resolve(conn);
            }
            else {
                console.log("Creating database "+databaseName);
                r.dbCreate(databaseName).run(conn)
                .then(function(){
                    console.log("Created database "+databaseName);
                    //Resolve with the connection so we can chain setup promises more cleanly
                    resolve(conn);
                });
            }
        });
    });
}

// Sets up the tables (Promise)
function ensureTablesExist(conn) {
    return new Promise(function(resolve, reject){
        console.log("Checking if table "+tableName+" exists");
        r.db(databaseName).tableList().contains(tableName).run(conn)
        .then(function(tableExists){
            if(tableExists) {
                console.log("Table "+tableName+" exists");
                resolve(conn);
            }
            else {
                console.log("Creating table "+tableName);
                r.db(databaseName).tableCreate(tableName).run(conn)
                .then(function(){
                    console.log("Created table "+tableName);
                    //Resolve with the connection so we can chain setup promises more cleanly
                    resolve(conn);
                });
            }
        });
    });
}

r.connect({
    // Connection options like host, port, user, password can go here
})
.then(function(conn){
    console.log("Connected to RethinkDB");
    return ensureDatabaseExists(conn);
})
.then(function(conn){
    return ensureTablesExist(conn);
})
.then(function(conn){
    console.log("Setting up routes");

    // POST (create) a new sighting
    app.post('/sightings', function(req, res) {
        var required_fields = ['state', 'description'];
        var errors = [];
        _.each(required_fields, function(required_field){
            if(typeof req.body[required_field] == "undefined") {
                errors.push('You must provide a '+required_field+'!');
            }
        });
        if(errors.length > 0) {
            return res.status(400).send(errors);
        }

        //Create the sighting
        r.db(databaseName).table(tableName).insert(req.body).run(conn)
        .then(function(status){
            return r.db(databaseName).table(tableName).get(status.generated_keys[0]).run(conn);
        })
        .then(function(sighting){
            // And then return the created object
            delete sighting.udid;
            res.json(sighting);
        })
        .catch(function(error){
            return res.status(500).send(error);
        });
    });

    // GET all sightings
    app.get('/sightings/:state', function(req, res) {
        r.db(databaseName).table(tableName).filter({state: req.params.state}).run(conn)
        .then(function(cursor){
            return cursor.toArray()
        })
        .then(function(sightings){
            res.json(sightings);
        });
    });

    // GET a specific sighting
    app.get('/sighting/:id', function(req, res) {
        r.db(databaseName).table(tableName).filter({id: req.params.id}).run(conn)
        .then(function(cursor){
            return cursor.toArray()
        })
        .then(function(sightings){
            if(sightings.length > 0) {
                var sighting = sightings[0];
                res.json(sighting);
            }
            else {
                res.sendStatus(404);
            }
        });
    });

    // PUT (update) a sighting
    app.put('/sighting/:id', function(req, res) {

        // First, see if the sighting exists
        r.db(databaseName).table(tableName).filter({id: req.params.id}).run(conn)
        .then(function(cursor){
            return cursor.toArray()
        })
        .then(function(sightings){
            if(sightings.length > 0) {
                var sighting = sightings[0];

                delete req.body.id;  //Possibly sending an id to update makes me nervous, let's make sure there isn't one

                r.db(databaseName).table(tableName).get(sighting.id).update(req.body).run(conn)
                .then(function(status){
                    return r.db(databaseName).table(tableName).get(sighting.id).run(conn);
                })
                .then(function(sighting){
                    // And then return the created object
                    res.json(sighting);
                })
                .catch(function(error){
                    return res.status(500).send(error);
                });

            }
            else {
                res.sendStatus(404);
            }
        })
        .catch(function(error){
            return res.status(500).send(error);
        });
    });

    // DELETE a sighting
    app.delete('/sighting/:id', function(req, res) {
        r.db(databaseName).table(tableName).filter({id: req.params.id}).delete().run(conn)
        .then(function(status){
            return res.json(status);
        })
        .catch(function(error){
            return res.status(500).send(error);
        });
    });

    // Subscribe to all sighting updates
    r.db(databaseName).table(tableName).changes().run(conn)
    .then(function(cursor){
        cursor.each(function (err, change) {
            if((change.new_val) && (!change.old_val)) {
                bayeux.getClient().publish('/sightings/'+change.new_val.state, {
                    type: "created",
                    sighting: change.new_val
                });
            }
            else if((change.new_val) && (change.old_val)) {
                bayeux.getClient().publish('/sightings/'+change.new_val.state, {
                    type: "updated",
                    sighting: change.new_val
                });
            }
            else {
                bayeux.getClient().publish('/sightings/'+change.old_val.state, {
                    type: "destroyed",
                    sighting: change.old_val
                });
            }
        });
    });

    return conn;

})
.catch(function(error){
    console.error(error);
});

const port = 3000;
server.listen(port, function () {
  console.log('Server is listening on port '+port+'!');
});