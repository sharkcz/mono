// -*- mode: js; js-indent-level: 4; -*-
//
// Run runtime tests under a JS shell or a browser
//

//glue code to deal with the differences between chrome, ch, d8, jsc and sm.
var is_browser = typeof window != "undefined";

if (is_browser) {
	// We expect to be run by tests/runtime/run.js which passes in the arguments using http parameters
	var url = new URL (decodeURI (window.location));
	arguments = [];
	for (var v of url.searchParams) {
		if (v [0] == "arg") {
			console.log ("URL ARG: " + v [0] + "=" + v [1]);
			arguments.push (v [1]);
		}
	}
}

if (is_browser || typeof print === "undefined")
	print = console.log;

// JavaScript core does not have a console defined
if (typeof console === "undefined") {
	var Console = function () {
		this.log = function(msg){ print(msg) };
	};
	console = new Console();
}

if (typeof console !== "undefined") {
	var has_console_warn = false;
	try {
		if (typeof console.warn !== "undefined")
			has_console_warn = true;
	} catch(e) {}

	if (!has_console_warn)
		console.warn = console.log;
}

if (typeof crypto == 'undefined') {
	// /dev/random doesn't work on js shells, so define our own
	// See library_fs.js:createDefaultDevices ()
	var crypto = {
		getRandomValues: function (buffer) {
			buffer[0] = (Math.random()*256)|0;
		}
	}
}

try {
	if (typeof arguments == "undefined")
		arguments = WScript.Arguments;
	load = WScript.LoadScriptFile;
	read = WScript.LoadBinaryFile;
} catch (e) {
}

try {
	if (typeof arguments == "undefined") {
		if (typeof scriptArgs !== "undefined")
			arguments = scriptArgs;
	}
} catch (e) {
}
//end of all the nice shell glue code.

// set up a global variable to be accessed in App.init
var testArguments = arguments;

function test_exit (exit_code) {
	if (is_browser) {
		// Notify the puppeteer script
		Module.exit_code = exit_code;
		print ("WASM EXIT " + exit_code);
	} else {
		Module.wasm_exit (exit_code);
	}
}

function fail_exec (reason) {
	print (reason);
	test_exit (1);
}

function inspect_object (o) {
    var r = "";
    for(var p in o) {
        var t = typeof o[p];
        r += "'" + p + "' => '" + t + "', ";
    }
    return r;
}

// Preprocess arguments
var args = testArguments;
print("Arguments: " + testArguments);
profilers = [];
setenv = {};
runtime_args = [];
enable_gc = false;
while (true) {
	if (args [0].startsWith ("--profile=")) {
		var arg = args [0].substring ("--profile=".length);

		profilers.push (arg);

		args = args.slice (1);
	} else if (args [0].startsWith ("--setenv=")) {
		var arg = args [0].substring ("--setenv=".length);
		var parts = arg.split ('=');
		if (parts.length != 2)
			fail_exec ("Error: malformed argument: '" + args [0]);
		setenv [parts [0]] = parts [1];
		args = args.slice (1);
	} else if (args [0].startsWith ("--runtime-arg=")) {
		var arg = args [0].substring ("--runtime-arg=".length);
		runtime_args.push (arg);
		args = args.slice (1);
	} else if (args [0] == "--enable-gc") {
		enable_gc = true;
		args = args.slice (1);
	} else {
		break;
	}
}
testArguments = args;

if (typeof window == "undefined")
  load ("mono-config.js");

var Module = { 
	mainScriptUrlOrBlob: "dotnet.js",

	print: function(x) { print ("WASM: " + x) },
	printErr: function(x) { print ("WASM-ERR: " + x) },

	onAbort: function(x) {
		print ("ABORT: " + x);
		var err = new Error();
		print ("Stacktrace: \n");
		print (err.stack);
		test_exit (1);
	},

	onRuntimeInitialized: function () {
		// Have to set env vars here to enable setting MONO_LOG_LEVEL etc.
		var wasm_setenv = Module.cwrap ('mono_wasm_setenv', 'void', ['string', 'string']);
		for (var variable in setenv) {
			MONO.mono_wasm_setenv (variable, setenv [variable]);
		}

		if (enable_gc) {
			var f = Module.cwrap ('mono_wasm_enable_on_demand_gc', 'void', []);
			f ();
		}

		MONO.mono_load_runtime_and_bcl (
			config.vfs_prefix,
			config.deploy_prefix,
			config.enable_debugging,
			config.file_list,
			function () {
				App.init ();
			},
			function (asset)
			{
			  if (typeof window != 'undefined') {
				return fetch (asset, { credentials: 'same-origin' });
			  } else {
				// The default mono_load_runtime_and_bcl defaults to using
				// fetch to load the assets.  It also provides a way to set a 
				// fetch promise callback.
				// Here we wrap the file read in a promise and fake a fetch response
				// structure.
				return new Promise((resolve, reject) => {
					 var response = { ok: true, url: asset, 
							arrayBuffer: function() {
								return new Promise((resolve2, reject2) => {
									resolve2(new Uint8Array (read (asset, 'binary')));
							}
						)}
					}
				   resolve(response)
				 })
			  }
			}
		);
	},
};

if (typeof window == "undefined")
  load ("dotnet.js");

const IGNORE_PARAM_COUNT = -1;

var App = {
    init: function () {

		var assembly_load = Module.cwrap ('mono_wasm_assembly_load', 'number', ['string'])
		var find_class = Module.cwrap ('mono_wasm_assembly_find_class', 'number', ['number', 'string', 'string'])
		var find_method = Module.cwrap ('mono_wasm_assembly_find_method', 'number', ['number', 'string', 'number'])
		var runtime_invoke = Module.cwrap ('mono_wasm_invoke_method', 'number', ['number', 'number', 'number', 'number']);
		var string_from_js = Module.cwrap ('mono_wasm_string_from_js', 'number', ['string']);
		var assembly_get_entry_point = Module.cwrap ('mono_wasm_assembly_get_entry_point', 'number', ['number']);
		var string_get_utf8 = Module.cwrap ('mono_wasm_string_get_utf8', 'string', ['number']);
		var string_array_new = Module.cwrap ('mono_wasm_string_array_new', 'number', ['number']);
		var obj_array_set = Module.cwrap ('mono_wasm_obj_array_set', 'void', ['number', 'number', 'number']);
		var exit = Module.cwrap ('mono_wasm_exit', 'void', ['number']);
		var wasm_setenv = Module.cwrap ('mono_wasm_setenv', 'void', ['string', 'string']);
		var wasm_set_main_args = Module.cwrap ('mono_wasm_set_main_args', 'void', ['number', 'number']);
		var wasm_strdup = Module.cwrap ('mono_wasm_strdup', 'number', ['string']);
		var unbox_int = Module.cwrap ('mono_unbox_int', 'number', ['number']);

		Module.wasm_exit = Module.cwrap ('mono_wasm_exit', 'void', ['number']);

		Module.print("Initializing.....");

		for (var i = 0; i < profilers.length; ++i) {
			var init = Module.cwrap ('mono_wasm_load_profiler_' + profilers [i], 'void', ['string'])

			init ("");
		}

		if (args[0] == "--regression") {
			var exec_regression = Module.cwrap ('mono_wasm_exec_regression', 'number', ['number', 'string'])

			var res = 0;
				try {
					res = exec_regression (10, args[1]);
					Module.print ("REGRESSION RESULT: " + res);
				} catch (e) {
					Module.print ("ABORT: " + e);
					print (e.stack);
					res = 1;
				}

			if (res)
				fail_exec ("REGRESSION TEST FAILED");

			return;
		}

		if (runtime_args.length > 0)
			MONO.mono_wasm_set_runtime_options (runtime_args);

		if (args[0] == "--run") {
			// Run an exe
			if (args.length == 1)
				fail_exec ("Error: Missing main executable argument.");
			main_assembly = assembly_load (args[1]);
			if (main_assembly == 0)
				fail_exec ("Error: Unable to load main executable '" + args[1] + "'");
			main_method = assembly_get_entry_point (main_assembly);
			if (main_method == 0)
				fail_exec ("Error: Main (string[]) method not found.");

			var app_args = string_array_new (args.length - 2);
			for (var i = 2; i < args.length; ++i) {
				obj_array_set (app_args, i - 2, string_from_js (args [i]));
			}

			var main_argc = args.length - 2 + 1;
			var main_argv = Module._malloc (main_argc * 4);
			aindex = 0;
			Module.setValue (main_argv + (aindex * 4), wasm_strdup (args [1]), "i32")
			aindex += 1;
			for (var i = 2; i < args.length; ++i) {
				Module.setValue (main_argv + (aindex * 4), wasm_strdup (args [i]), "i32");
				aindex += 1;
			}
			wasm_set_main_args (main_argc, main_argv);

			try {
				var invoke_args = Module._malloc (4);
				Module.setValue (invoke_args, app_args, "i32");
				var eh_exc = Module._malloc (4);
				Module.setValue (eh_exc, 0, "i32");
				var res = runtime_invoke (main_method, 0, invoke_args, eh_exc);
				var eh_res = Module.getValue (eh_exc, "i32");
				if (eh_res != 0) {
					print ("Exception:" + string_get_utf8 (res));
					test_exit (1);
				}
				var exit_code = unbox_int (res);
				if (exit_code != 0)
					test_exit (exit_code);
			} catch (ex) {
				print ("JS exception: " + ex);
				print (ex.stack);
				test_exit (1);
			}

			if (is_browser)
				test_exit (0);

			return;
		}

		Module.print("Initializing Binding Test Suite support.....");

		//binding test suite support code
		binding_test_module = assembly_load ("binding_tests");
		if (!binding_test_module)
		{
			Module.printErr("Binding tests module 'binding_tests' not found.  Exiting Tests.")
			throw new Error("Binding tests module 'binding_tests' not found.  Exiting Tests.");
		}
		
		binding_test_class = find_class (binding_test_module, "", "TestClass");
		if (!binding_test_class)
		{
			Module.printErr("Binding tests class 'TestClass' not found.  Exiting Tests.")
			throw new Error("Binding tests class 'TestClass' not found.  Exiting Tests.");
		}		

		Module.print("Binding support complete.");

		
		Module.print("Checking for [main]Driver:Send ....");
		
		var send_message = undefined;
		
		try
		{
			send_message = BINDING.bind_static_method("[main]Driver:Send");
		}
		catch (e)
		{
			Module.printErr("[main]Driver:Send not found: " + e);
			throw e;
		
		}

		Module.print("Driver binding complete.");

		var main_argc = 1
		var main_argv = Module._malloc (main_argc * 4);
		Module.setValue (main_argv, wasm_strdup ("mono-wasm"), "i32")
		wasm_set_main_args (main_argc, main_argv);

		var bad_send_msg_detected = false;
		for (var i = 0; i < testArguments.length; ++i) {
			if (testArguments [i] == "--exclude") {
				send_message ("--exclude", testArguments [i + 1]);
				i ++;
				continue;
			}
			var res = "";
			try
			{
				res = send_message("start-test", testArguments [i])
			} catch (e) {
				Module.printErr ("BAD SEND MSG: " + e);
				bad_send_msg_detected = true;
			}
			print ("-----STARTED " + testArguments [i] + "---- " + res);

			if (res == "SUCCESS") {
				while (send_message ("pump-test", testArguments [i]) != "DONE") 
				{
					Module.pump_message ();
					print ("|");
				}
				print ("\nDONE")
			}
		}

		var status = send_message ("test-result", "");
		print ("Test status " + status)
		if (status != "PASS")
			fail_exec ("BAD TEST STATUS");

		if (bad_send_msg_detected)
			fail_exec ("BAD MSG SEND DETECTED");
		test_exit (0);
    },
};

//binding test suite support code
var binding_test_module = undefined;
var binding_test_class = undefined;

// This function is called from the binding test suite
function call_test_method(method_name, signature, args)
{
	var target_method = find_method (binding_test_class, method_name, IGNORE_PARAM_COUNT)
	if (!target_method)
		throw "Could not find " + method_name;

	return Module.mono_method_invoke (target_method, null, signature, args);
}
