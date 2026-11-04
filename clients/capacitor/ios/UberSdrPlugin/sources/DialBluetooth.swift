import CoreBluetooth
import CryptoKit
import UIKit

/// The UberSDR Dial over Bluetooth, for a receiver page that has no Web
/// Bluetooth — the iOS half of src/hostbluetooth.js, whose header has the
/// protocol. The Android half is DialBluetooth.java, and this follows it.
///
/// Only the Dial: the chooser scans for the Dial's service and nothing else, a
/// connection is only ever made to a dial the operator picked there (or the one
/// picked last time, remembered), and only that service's characteristics are
/// reachable. The page asking is a remote receiver's.
///
/// Where iOS differs from Android:
///
/// - **The permission prompt comes with the central manager.** Creating a
///   CBCentralManager is what asks, so one is only made when the operator
///   presses Connect, or for a quiet reconnect when permission is already
///   granted — never by a page load on its own.
/// - **A connect never times out.** iOS keeps trying until it is cancelled, so
///   the 10 s limit is this file's.
/// - **Operations queue in CoreBluetooth.** Callbacks arrive in the order the
///   operations were issued, so each characteristic keeps a FIFO of the
///   request ids waiting on it; no queue of our own.
/// - **No addresses.** A peripheral is a per-app UUID. The page sees a token
///   derived from it, as on Android.
final class DialBluetooth: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {

    static let service = CBUUID(string: "89540001-8c77-4d5f-9411-e7534b50c873")

    private static let connectSeconds: TimeInterval = 10
    private static let rememberedKey = "ubersdr.dial.peripheral"
    private static let rememberedNameKey = "ubersdr.dial.name"

    /// Whether to offer the Dial over Bluetooth at all. Not refused or
    /// restricted: a page told there is Bluetooth when Settings says no would
    /// offer a Connect that can only fail.
    static func offered() -> Bool {
        switch CBManager.authorization {
        case .denied, .restricted: return false
        default: return true
        }
    }

    private let send: (String) -> Void
    weak var presenter: UIViewController?

    private var central: CBCentralManager?
    /// Run once the manager says it is powered on (or fails, with the reason).
    private var whenReady: [(String?) -> Void] = []

    /// Dials seen or picked in this run, by token: the only ones connect() accepts.
    private var known: [String: CBPeripheral] = [:]

    // The chooser, while it is open.
    private var requestId: Int?
    private var chooser: DialChooser?

    // The connection.
    private var peripheral: CBPeripheral?
    private var token: String?
    private var connectId: Int?
    private var connectTimer: Timer?
    private var chars: [String: CBCharacteristic] = [:]
    /// Request ids waiting on each characteristic's next callback, in order.
    private var waiting: [String: [Int]] = [:]

    init(send: @escaping (String) -> Void) {
        self.send = send
        super.init()
    }

    // MARK: - The page

    func handle(_ type: String, _ message: [String: Any]) {
        let id = (message["id"] as? NSNumber)?.intValue ?? 0
        let device = message["device"] as? String ?? ""
        switch type {
        case "ble-request":
            request(id)
        case "ble-devices":
            devices(id)
        case "ble-connect":
            connect(id, device)
        case "ble-notify":
            notify(id, device, (message["char"] as? String ?? "").lowercased())
        case "ble-write":
            write(id, device, (message["char"] as? String ?? "").lowercased(),
                  message["value"] as? String ?? "",
                  (message["response"] as? Bool) ?? true)
        case "ble-disconnect":
            // Quietly: the page already knows, and an echo arriving after it
            // had started connecting again would cancel that attempt.
            if device == token { disconnect(quiet: true) }
        default:
            break
        }
    }

    private func reply(_ id: Int, _ body: [String: Any] = [:]) {
        var body = body
        body["id"] = id
        guard let data = try? JSONSerialization.data(withJSONObject: body),
              let json = String(data: data, encoding: .utf8) else { return }
        send("ble-reply:" + json)
    }

    private func fail(_ id: Int, _ name: String, _ message: String) {
        reply(id, ["error": ["name": name, "message": message]])
    }

    private func event(_ prefix: String, _ body: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: body),
              let json = String(data: data, encoding: .utf8) else { return }
        send(prefix + ":" + json)
    }

    static func token(_ peripheral: CBPeripheral) -> String {
        let digest = SHA256.hash(data: Data(("ubersdr-dial:" + peripheral.identifier.uuidString).utf8))
        return "dial-" + digest.prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    private static func displayName(_ name: String?) -> String {
        guard let name = name, !name.isEmpty else { return "UberSDR Dial" }
        return name
    }

    // MARK: - The manager

    /// The manager, made on first need — which is what shows the permission
    /// prompt the first time. `then` runs once it is powered on, or with a
    /// reason it cannot be.
    private func ready(_ then: @escaping (String?) -> Void) {
        if let central = central {
            switch central.state {
            case .poweredOn: then(nil); return
            case .unknown, .resetting: whenReady.append(then); return
            default: then(Self.reason(central.state)); return
            }
        }
        whenReady.append(then)
        central = CBCentralManager(delegate: self, queue: .main)
    }

    private static func reason(_ state: CBManagerState) -> String {
        switch state {
        case .poweredOff: return "Bluetooth is switched off"
        case .unauthorized: return "UberSDR is not allowed to use Bluetooth — allow it in Settings › UberSDR"
        case .unsupported: return "this device has no Bluetooth LE"
        default: return "Bluetooth is not ready"
        }
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .unknown || central.state == .resetting { return }
        let callbacks = whenReady
        whenReady = []
        let problem = central.state == .poweredOn ? nil : Self.reason(central.state)
        for callback in callbacks { callback(problem) }
        if central.state != .poweredOn, peripheral != nil {
            // Bluetooth switched off under a connection: it has gone.
            disconnect(quiet: false)
        }
    }

    // MARK: - Remembered dial

    private func devices(_ id: Int) {
        // Nothing unless permission is already held: this is the page's quiet
        // reconnect, and must never be the thing that shows a prompt.
        guard CBManager.authorization == .allowedAlways,
              let saved = UserDefaults.standard.string(forKey: Self.rememberedKey),
              let uuid = UUID(uuidString: saved) else {
            reply(id, ["devices": []])
            return
        }
        ready { [weak self] problem in
            guard let self = self else { return }
            guard problem == nil, let central = self.central,
                  let p = central.retrievePeripherals(withIdentifiers: [uuid]).first else {
                self.reply(id, ["devices": []])
                return
            }
            let token = Self.token(p)
            self.known[token] = p
            let name = UserDefaults.standard.string(forKey: Self.rememberedNameKey) ?? p.name
            self.reply(id, ["devices": [["id": token, "name": Self.displayName(name)]]])
        }
    }

    // MARK: - The chooser

    private func request(_ id: Int) {
        if requestId != nil {
            fail(id, "InvalidStateError", "a device chooser is already open")
            return
        }
        requestId = id
        ready { [weak self] problem in
            guard let self = self, self.requestId == id else { return }
            if let problem = problem {
                self.endRequest()
                self.fail(id, "NotAllowedError", problem)
                return
            }
            self.showChooser()
        }
    }

    private func showChooser() {
        guard let presenter = topmost(presenter) else {
            let id = requestId ?? 0
            endRequest()
            fail(id, "NotAllowedError", "nowhere to show the chooser")
            return
        }
        let chooser = DialChooser { [weak self] index in
            self?.picked(index)
        }
        self.chooser = chooser
        let nav = UINavigationController(rootViewController: chooser)
        nav.modalPresentationStyle = .formSheet
        presenter.present(nav, animated: true)
        central?.scanForPeripherals(withServices: [Self.service],
                                    options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
    }

    private func topmost(_ vc: UIViewController?) -> UIViewController? {
        var top = vc
        while let next = top?.presentedViewController { top = next }
        return top
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        guard requestId != nil, let chooser = chooser else { return }
        let name = Self.displayName(advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? peripheral.name)
        chooser.found(peripheral, name: name)
    }

    /// `index` nil: cancelled.
    private func picked(_ index: Int?) {
        guard let id = requestId else { return }
        let entry = index.flatMap { chooser?.entry($0) }
        endRequest()
        guard let (p, name) = entry else {
            fail(id, "NotFoundError", "no dial chosen")
            return
        }
        let token = Self.token(p)
        known[token] = p
        // The one remembered, as on Android and the desktop: the last picked.
        UserDefaults.standard.set(p.identifier.uuidString, forKey: Self.rememberedKey)
        UserDefaults.standard.set(name, forKey: Self.rememberedNameKey)
        reply(id, ["device": ["id": token, "name": name]])
    }

    private func endRequest() {
        requestId = nil
        if central?.state == .poweredOn { central?.stopScan() }
        if let chooser = chooser {
            self.chooser = nil
            chooser.onDone = nil
            chooser.navigationController?.dismiss(animated: true)
        }
    }

    // MARK: - The connection

    private func connect(_ id: Int, _ device: String) {
        guard let p = known[device] else {
            fail(id, "NotFoundError", "that is not a dial picked here")
            return
        }
        ready { [weak self] problem in
            guard let self = self else { return }
            if let problem = problem {
                self.fail(id, "NetworkError", problem)
                return
            }
            // One dial at a time: a second connect replaces the first.
            if self.peripheral != nil { self.disconnect(quiet: true) }
            self.peripheral = p
            self.token = device
            self.connectId = id
            self.chars = [:]
            self.waiting = [:]
            p.delegate = self
            self.central?.connect(p, options: nil)
            self.connectTimer = Timer.scheduledTimer(withTimeInterval: Self.connectSeconds, repeats: false) {
                [weak self] _ in
                guard let self = self, self.peripheral === p, self.connectId != nil else { return }
                self.failConnect("the dial did not answer — is it on, and in Controller · Bluetooth?")
            }
        }
    }

    private func failConnect(_ message: String, name: String = "NetworkError") {
        let id = connectId
        connectId = nil
        closePeripheral()
        if let id = id { fail(id, name, message) }
    }

    /// Lets go of the dial. `quiet` when the page already knows — it asked, or
    /// it has gone; otherwise the page is told the link dropped.
    private func disconnect(quiet: Bool) {
        let gone = token
        if let id = connectId {
            connectId = nil
            fail(id, "AbortError", "the connection was cancelled")
        }
        closePeripheral()
        if !quiet, let gone = gone { event("ble-disconnected", ["device": gone]) }
    }

    private func closePeripheral() {
        connectTimer?.invalidate()
        connectTimer = nil
        for (_, ids) in waiting {
            for id in ids { fail(id, "NetworkError", "the dial disconnected") }
        }
        waiting = [:]
        chars = [:]
        let p = peripheral
        peripheral = nil
        token = nil
        if let p = p, let central = central, central.state == .poweredOn {
            central.cancelPeripheralConnection(p)
        }
    }

    /// The page has gone (a navigation, or the receiver closing): let go of everything.
    func close() {
        if let id = requestId {
            endRequest()
            fail(id, "AbortError", "the page went away")
        }
        if peripheral != nil { disconnect(quiet: true) }
    }

    func centralManager(_ central: CBCentralManager, didConnect p: CBPeripheral) {
        guard p === peripheral, connectId != nil else { return }
        p.discoverServices([Self.service])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        guard p === peripheral, connectId != nil else { return }
        failConnect("could not connect to the dial: \(error?.localizedDescription ?? "unknown error")")
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        guard p === peripheral else { return }
        if connectId != nil {
            failConnect("the dial disconnected while connecting")
            return
        }
        NSLog("[UberSDR dial] disconnected: \(error?.localizedDescription ?? "by request")")
        // Already disconnected; only the bookkeeping and the page remain.
        let gone = token
        peripheral = nil
        closePeripheral()
        if let gone = gone { event("ble-disconnected", ["device": gone]) }
    }

    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        guard p === peripheral, connectId != nil else { return }
        guard error == nil, let service = p.services?.first(where: { $0.uuid == Self.service }) else {
            failConnect("that device is not an UberSDR Dial", name: "NotFoundError")
            return
        }
        p.discoverCharacteristics(nil, for: service)
    }

    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard p === peripheral, let id = connectId else { return }
        guard error == nil else {
            failConnect("could not read the dial's characteristics")
            return
        }
        connectTimer?.invalidate()
        connectTimer = nil
        connectId = nil
        var uuids: [String] = []
        for c in service.characteristics ?? [] {
            let uuid = Self.uuidString(c.uuid)
            chars[uuid] = c
            uuids.append(uuid)
        }
        reply(id, ["services": [["uuid": Self.uuidString(Self.service), "chars": uuids]]])
    }

    /// The full lower-case form the page uses (CBUUID shortens the standard ones).
    private static func uuidString(_ uuid: CBUUID) -> String {
        uuid.uuidString.lowercased()
    }

    // MARK: - Operations

    private func characteristic(_ id: Int, _ device: String, _ uuid: String) -> CBCharacteristic? {
        guard peripheral != nil, connectId == nil, device == token else {
            fail(id, "NetworkError", "not connected")
            return nil
        }
        guard let c = chars[uuid] else {
            fail(id, "NotFoundError", "no such characteristic on the dial")
            return nil
        }
        return c
    }

    private func notify(_ id: Int, _ device: String, _ uuid: String) {
        guard let c = characteristic(id, device, uuid), let p = peripheral else { return }
        waiting["n:" + uuid, default: []].append(id)
        p.setNotifyValue(true, for: c)
    }

    private func write(_ id: Int, _ device: String, _ uuid: String, _ value64: String, _ response: Bool) {
        guard let c = characteristic(id, device, uuid), let p = peripheral else { return }
        guard let value = Data(base64Encoded: value64) else {
            fail(id, "TypeError", "not base64")
            return
        }
        guard value.count <= 512 else {
            fail(id, "InvalidModificationError", "value too long")
            return
        }
        if response {
            waiting["w:" + uuid, default: []].append(id)
            p.writeValue(value, for: c, type: .withResponse)
        } else {
            // No callback comes for these: queued is as done as it gets.
            p.writeValue(value, for: c, type: .withoutResponse)
            reply(id)
        }
    }

    private func next(_ key: String) -> Int? {
        guard var ids = waiting[key], !ids.isEmpty else { return nil }
        let id = ids.removeFirst()
        waiting[key] = ids
        return id
    }

    func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor c: CBCharacteristic, error: Error?) {
        guard p === peripheral, let id = next("n:" + Self.uuidString(c.uuid)) else { return }
        if let error = error { fail(id, "NetworkError", error.localizedDescription) } else { reply(id) }
    }

    func peripheral(_ p: CBPeripheral, didWriteValueFor c: CBCharacteristic, error: Error?) {
        guard p === peripheral, let id = next("w:" + Self.uuidString(c.uuid)) else { return }
        if let error = error {
            fail(id, "NetworkError", "the dial refused the write (\(error.localizedDescription))")
        } else {
            reply(id)
        }
    }

    func peripheral(_ p: CBPeripheral, didUpdateValueFor c: CBCharacteristic, error: Error?) {
        guard p === peripheral, error == nil, let token = token, let value = c.value else { return }
        event("ble-value", ["device": token, "char": Self.uuidString(c.uuid),
                            "value": value.base64EncodedString()])
    }
}

/// The list of dials found so far, filling in as they advertise.
private final class DialChooser: UITableViewController {
    var onDone: ((Int?) -> Void)?
    private var dials: [(CBPeripheral, String)] = []

    init(onDone: @escaping (Int?) -> Void) {
        self.onDone = onDone
        super.init(style: .insetGrouped)
        title = "Connect to an UberSDR Dial"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .cancel, target: self, action: #selector(cancel))
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "dial")
        // Swiped down is cancelled too.
        navigationController?.presentationController?.delegate = self
    }

    @objc private func cancel() {
        let done = onDone
        onDone = nil
        done?(nil)
    }

    func entry(_ index: Int) -> (CBPeripheral, String)? {
        index >= 0 && index < dials.count ? dials[index] : nil
    }

    func found(_ peripheral: CBPeripheral, name: String) {
        if let i = dials.firstIndex(where: { $0.0 === peripheral }) {
            // The name arrives with the scan response, after the first sighting.
            if dials[i].1 != name && name != "UberSDR Dial" {
                dials[i].1 = name
                tableView.reloadRows(at: [IndexPath(row: i, section: 0)], with: .none)
            }
            return
        }
        dials.append((peripheral, name))
        tableView.reloadData()
    }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        dials.count
    }

    override func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? {
        "Looking for dials… On the dial, choose Controller · Bluetooth."
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "dial", for: indexPath)
        cell.textLabel?.text = dials[indexPath.row].1
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        let done = onDone
        onDone = nil
        done?(indexPath.row)
    }
}

extension DialChooser: UIAdaptivePresentationControllerDelegate {
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        cancel()
    }
}
