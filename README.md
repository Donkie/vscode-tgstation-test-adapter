# Tgstation Test Explorer for Visual Studio Code

This is a VS Code Test Explorer adapter for BYOND's DM language and software, which will greatly improve the user experience of working with unit tests in BYOND projects. It is originally made for the [tgstation](https://github.com/tgstation/tgstation) codebase but tries to be as compatible as possible with other projects.

## Features

- Automatically finds and lists all unit tests in the project
- Compile and run the project in unit-testing mode with one click
- Displays success status of each unit test
- View error messages when unit tests fail

Note: This extension is completely untested on anything but Windows 10. Detecting when dreamdaemon ends is abit hacky, so it might not work perfectly for other OSes. Please let me know if you have issues about this.

## Setup

Install this extension. Open a workspace containing a compatible codebase, press the flask icon to the left, press Run button at the top and watch it go!

You might need to set the path on your computer to the dreammaker compiler and dreamdaemon. These can be set in the user space extension settings.

### Output log

You can view some progress and debug messages if you open the vscode Output view, and switch to "Tgstation Test Explorer Log".

## Project Integration

This section is for you who wish to power your byond project with this test extension. If your project already supports it, you don't have to mind about this.

### Test Loading

Unit tests are found by searching through all \*.dm files in the workspace. Any line that matches the **Unit Test Definition Regex** pattern are designated as a separate unit test. The pattern can either match a datum definition such as:

    /datum/unit_test/my_test

Or a proc, such as

    /datum/unit_test/my_test/Run()

In either case, it is vital that "my_test" will be captured as the first regex capturing group.

_Limitation: Currently, unit tests must be a subtype of specifically `/datum/unit_test`_

The file that one or more unit tests were found in will become the "test suite".

### Test Running

Firstly, one or several configurable #defines are injected in the beginning of the project's .dme file. For tgstation, the define `#define CIBUILDING` is for example appropriate since that would cause the server to run unit tests and then stop once they are done.

With the modified .dme, the project is compiled and then dreamdaemon is fired up. Once dreamdaemon exits, the tests are considered finished. The paths to the dm compiler and dreamdaemon are configurable on a vscode user level.

### Result Gathering

Test results can be gathered by interpreting the unit_test.log file as done in tgstation. However, since different codebases had different ways of doing this, I came up with a standardized json log format. To adhere to that standard, the results of the unit tests should be saved in a file placed at `data/unit_tests.json`. This json file should look like:

    {
        "/datum/unit_test/my_test": {
    	    "status": 0,
    	    "message": "Success!",
    	    "name": "My Test"
    	},
        "/datum/unit_test/my_second_test": {
    	    "status": 1,
    	    "message": "Expected 3, got 5",
    	    "name": "My Second Test"
        }
    }

Status can be one of 0, 1 or 2, meaning Passed, Failed or Skipped.
If the test is passed, message can be empty.
The name property is currently not used in the extension, but it is intended to give a pretty name to the test.

### Configuration

Here is a full list of project level configurations which you probably need to set. These are of course also available through vscode's built in settings UI.
| Name | Description | Default value |
|--|--|--|
| DMEName | The name of your project's .dme file | tgstation.dme |
| Defines | An array of code rows to inject to the start of the .dme when compiling | ['#define CIBUILDING'] |
| Results Type | Either 'log' or 'json'. | log |
| Unit Test Definition Regex | Regex used to match a unit test definition code line | /?datum/unit_test/([\\w/]+)/Run\\s\*\\( |
