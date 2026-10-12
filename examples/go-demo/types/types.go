package types

type Customer struct {
	ID        string
	IsPremium bool
}

// Item may be a bundle: Children holds the items it contains.
type Item struct {
	SKU      string
	Price    float64
	Children []Item
}

type Cart struct {
	Customer Customer
	Items    []Item
}

type Receipt struct {
	PaymentID string
	Total     float64
	Discount  float64
}
